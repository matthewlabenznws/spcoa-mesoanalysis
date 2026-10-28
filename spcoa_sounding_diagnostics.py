#!/usr/bin/env python3
"""SPCOA WeatherFront-style HRRR F00 sounding diagnostic engine.

Reads native columns from spcoa_soundings.py v1 S3 tiles or a JSON profile.
Computes thermodynamics from the selected profile; never substitutes gridded
SPCOA CAPE/ECAPE overlays. Output is a JSON data contract for the UI.

Install: pip install numpy metpy sharppy ecape boto3
Usage:
  python spcoa_sounding_diagnostics.py selftest
  python spcoa_sounding_diagnostics.py profile --input profile.json --output diag.json
  python spcoa_sounding_diagnostics.py s3 --run 20261028_06 --lat 41.18 --lon -100.69 --output diag.json

Cautions: SHARPpy inferred temperature advection is a thermal-wind estimate,
NOT gridded -V dot grad(T). The surface row combines 2-m thermo and 10-m winds.
"""
from __future__ import annotations
import argparse, gzip, json, math
from pathlib import Path
import numpy as np

KTS_PER_MS = 1.94384449244

def number(x):
    try:
        a = float(x)
        return round(a, 4) if np.isfinite(a) else None
    except (TypeError, ValueError):
        return None

def scalar(x):
    try:
        v = np.ma.asarray(x).filled(np.nan)
        return number(np.asarray(v).reshape(-1)[0])
    except Exception:
        return None

def pressure_mean(p, values, low, high):
    """Exact trapezoidal pressure-weighted mean, with interpolated endpoints."""
    p, values = np.asarray(p, float), np.asarray(values, float)
    good = np.isfinite(p) & np.isfinite(values)
    p, values = p[good], values[good]
    if len(p) < 2: return np.nan
    idx = np.argsort(p); p, values = p[idx], values[idx]
    if low < p[0] - 1e-5 or high > p[-1] + 1e-5 or low >= high:
        return np.nan
    sample = np.r_[low, p[(p > low) & (p < high)], high]
    sampled = np.interp(sample, p, values)
    return float(np.trapezoid(sampled, sample) / (high-low)) if hasattr(np, 'trapezoid') else float(np.trapz(sampled, sample)/(high-low))

def prepare(raw):
    keys = ('pressure_hpa','temperature_k','specific_humidity_kgkg','height_m_msl','u_ms','v_ms')
    arr = {k:np.asarray(raw[k], float) for k in keys}
    if len({len(x) for x in arr.values()}) != 1:
        raise ValueError('Profile field length mismatch')
    mask = np.ones(len(arr[keys[0]]), bool)
    for k in keys: mask &= np.isfinite(arr[k])
    mask &= (arr['pressure_hpa'] > 80) & (arr['pressure_hpa'] < 1100)
    mask &= (arr['temperature_k'] > 160) & (arr['temperature_k'] < 345)
    mask &= (arr['specific_humidity_kgkg'] >= 0) & (arr['specific_humidity_kgkg'] < 0.07)
    mask &= (arr['height_m_msl'] > -600) & (arr['height_m_msl'] < 35000)
    if mask.sum() < 20: raise ValueError('Fewer than 20 complete levels')
    # Keep the true surface record first when valid, then native levels in pressure order.
    sfc_valid = bool(mask[0])
    surf = 0 if sfc_valid else int(np.argmax(np.where(mask,arr['pressure_hpa'],-np.inf)))
    others = np.where(mask & (np.arange(len(mask)) != surf))[0]
    others = others[np.argsort(-arr['pressure_hpa'][others])]
    chosen = [surf]
    lastp = arr['pressure_hpa'][surf]
    for i in others:
        if arr['pressure_hpa'][i] < lastp-0.15 and arr['height_m_msl'][i] > arr['height_m_msl'][chosen[-1]]-20:
            chosen.append(int(i)); lastp=arr['pressure_hpa'][i]
    a = {k:v[chosen] for k,v in arr.items()}
    if len(chosen) < 20: raise ValueError('Not enough usable monotonic pressure levels')
    a['height_m_agl'] = a['height_m_msl']-a['height_m_msl'][0]
    a['surface_is_mixed_height'] = sfc_valid
    return a

def native_profile(raw):
    from metpy.units import units
    import metpy.calc as mp
    a = prepare(raw)
    p=a['pressure_hpa']; t=a['temperature_k']; q=a['specific_humidity_kgkg']; h=a['height_m_agl']
    # MetPy specific_humidity_to_dewpoint accepts kg/kg specific humidity.
    dew = mp.dewpoint_from_specific_humidity(p*units.hPa, t*units.kelvin, q*units.dimensionless).to('degC').m
    tc=t-273.15
    rh = np.clip(mp.relative_humidity_from_dewpoint(t*units.kelvin, dew*units.degC).m*100,0,100)
    return a, tc, np.asarray(dew,float), np.asarray(rh,float)

def make_sharppy(a,tc,dew):
    from sharppy.sharptab import profile
    return profile.create_profile(profile='default',pres=a['pressure_hpa'],hght=a['height_m_msl'],
        tmpc=tc,dwpc=dew, u=a['u_ms']*KTS_PER_MS,v=a['v_ms']*KTS_PER_MS,
        missing=-9999, strictQC=False)

def parcel_report(parcel):
    report = {k: scalar(getattr(parcel, attribute, None)) for k,attribute in {
        'cape_jkg':'bplus','cin_jkg':'bminus','lcl_hpa':'lclpres',
        'lcl_m_agl':'lclhght','lfc_hpa':'lfcpres','lfc_m_agl':'lfchght',
        'el_hpa':'elpres','el_m_agl':'elhght','li_c':'li5',
        'cape_0_3km_jkg':'b3km','cape_0_6km_jkg':'b6km'}.items()}
    for source, target in [('ptrace','trace_pressure_hpa'),('ttrace','trace_temperature_c')]:
        try:
            vec = np.ma.asarray(getattr(parcel, source)).filled(np.nan).astype(float)
            report[target] = [number(x) for x in vec] if vec.ndim == 1 else []
        except Exception:
            report[target] = []
    return report

def layer_uv(a,bot,top):
    z = a['height_m_agl']; u=a['u_ms'];v=a['v_ms']
    if bot < z.min() or top > z.max() or top <= bot: return None
    zgrid=np.r_[bot,z[(z>bot)&(z<top)],top]
    integral = lambda y: np.trapezoid(y,zgrid)/(top-bot) if hasattr(np,'trapezoid') else np.trapz(y,zgrid)/(top-bot)
    return np.asarray([integral(np.interp(zgrid,z,u)),integral(np.interp(zgrid,z,v))])

def wind_barbs(a):
    p=a['pressure_hpa']; p0=float(p[0]); pmin=float(p[-1]);
    targets=np.arange(math.floor(p0/50)*50, max(100,pmin)-.01,-50,dtype=float)
    out=[]
    for level in targets:
        if level > p0 or level < pmin: continue
        u=float(np.interp(level,p[::-1],a['u_ms'][::-1]))*KTS_PER_MS
        v=float(np.interp(level,p[::-1],a['v_ms'][::-1]))*KTS_PER_MS
        out.append({'pressure_hpa':int(level),'u_kt':number(u),'v_kt':number(v),
                    'speed_kt':number(math.hypot(u,v)),'direction_deg':number((270-math.degrees(math.atan2(v,u)))%360)})
    return out

def inferred_advection(prof,latitude):
    from sharppy.sharptab import params
    try:
        fn=getattr(params,'inferred_temp_advection',None) or getattr(params,'inferred_temp_adv',None)
        if fn is None: return [], 'SHARPpy inferred temperature-advection function unavailable'
        try: adv,bounds=fn(prof,dp=-100,lat=latitude)
        except TypeError: adv,bounds=fn(prof,lat=latitude)
        results=[]
        for value,bound in zip(np.ma.asarray(adv),np.ma.asarray(bounds)):
            x=scalar(value); b=np.ma.asarray(bound).filled(np.nan).reshape(-1)
            if x is not None and len(b)>=2 and np.isfinite(b[:2]).all():
                results.append({'bottom_hpa':number(b[0]),'top_hpa':number(b[1]),
                    'c_per_hr':x,'type':'WAA' if x>0 else 'CAA' if x<0 else 'neutral'})
        return results, None
    except Exception as exc:
        return [], str(exc)

def ecape_value(a):
    """Call published Peters ECAPE implementation; no fallback approximations."""
    try:
        from metpy.units import units
        from ecape.calc import calc_ecape
        # Published package expects bottom-up height, pressure, temperature, q, wind with pint units.
        result=calc_ecape(a['height_m_agl']*units.meter,
                          a['pressure_hpa']*units.hectopascal,
                          a['temperature_k']*units.kelvin,
                          a['specific_humidity_kgkg']*units.dimensionless,
                          a['u_ms']*units('m/s'),a['v_ms']*units('m/s'))
        val=scalar(result.to('J/kg').magnitude if hasattr(result,'to') else result)
        return val, None if val is not None else 'ECAPE returned nonfinite value'
    except Exception as exc:
        return None,str(exc)

def diagnostics(raw, ecape=True):
    from sharppy.sharptab import params, thermo
    from metpy.units import units
    import metpy.calc as mp
    a,tc,dew,rh=native_profile(raw)
    prof=make_sharppy(a,tc,dew)
    p=a['pressure_hpa'];t=a['temperature_k'];q=a['specific_humidity_kgkg'];z=a['height_m_agl']
    p0=p[0]; top=p0-100.
    # Method B: exact pressure-weighted means of conserved theta and mixing ratio.
    theta=t*(1000/p)**(287.05/1004.)
    r=q/(1-q)
    theta_ml=pressure_mean(p,theta,top,p0)
    r_ml=pressure_mean(p,r,top,p0)
    ml_initial=None
    parcels={}; errors={}
    for name,flag in [('sb',1),('mu',3)]:
        try:
            parcel=params.parcelx(prof,flag=flag)
            parcels[name]=parcel_report(parcel)
        except Exception as exc: errors[name]=str(exc);parcels[name]=None
    if np.isfinite(theta_ml) and np.isfinite(r_ml) and r_ml>0:
        t_ml=theta_ml*(p0/1000.)**(287.05/1004.)-273.15
        # SHARPpy mixratio expects g/kg, gives dewpoint C for target pressure.
        td_ml=float(thermo.temp_at_mixrat(r_ml*1000,p0))
        ml_initial={'pressure_hpa':number(p0),'temperature_c':number(t_ml),
                    'dewpoint_c':number(td_ml),'theta_k':number(theta_ml),
                    'mixing_ratio_gkg':number(r_ml*1000)}
        try:
            pc=params.parcelx(prof,flag=5,pres=p0,tmpc=t_ml,dwpc=td_ml)
            parcels['ml']=parcel_report(pc)
        except Exception as exc: errors['ml']=str(exc);parcels['ml']=None
    else: errors['ml']='Insufficient complete 100-hPa mixed layer';parcels['ml']=None
    # RH averaged uniformly in pressure between SB LCL and first LFC.
    rh_layer=None
    sb=parcels['sb']
    if sb and sb['lcl_hpa'] is not None and sb['lfc_hpa'] is not None and sb['lcl_hpa']>sb['lfc_hpa']:
        rh_layer=number(pressure_mean(p,rh,sb['lfc_hpa'],sb['lcl_hpa']))
    # Zeros/thin layers/nonexistent LFC are intentionally null and explicitly flagged.
    shear={}; meanwinds={}
    surface=np.asarray([a['u_ms'][0],a['v_ms'][0]])
    for depth in (500,1000,3000,6000,9000):
        if z[-1]>=depth:
            upper=np.asarray([np.interp(depth,z,a['u_ms']),np.interp(depth,z,a['v_ms'])])
            shear[f'0_{depth}m_kt']=number(np.linalg.norm(upper-surface)*KTS_PER_MS)
            avg=layer_uv(a,0,depth)
            meanwinds[f'0_{depth}m']={'u_kt':number(avg[0]*KTS_PER_MS),'v_kt':number(avg[1]*KTS_PER_MS)} if avg is not None else None
    # SHARPpy kinematics use the same profile. Effective inflow layer criteria: CAPE>=100 CIN>=-250.
    motions={};srh={}
    try:
        bm=params.bunkers_storm_motion(prof)
        mr,ml=bm[:2],bm[2:4]
        motions={'right':{'u_kt':scalar(mr[0]),'v_kt':scalar(mr[1])},
                 'left':{'u_kt':scalar(ml[0]),'v_kt':scalar(ml[1])}}
        for depth in (1000,3000):
            val=params.helicity(prof,0,depth,stu=mr[0],stv=mr[1]) if hasattr(params,'helicity') else None
            if val is None:
                from sharppy.sharptab import winds
                val=winds.helicity(prof,0,depth,stu=mr[0],stv=mr[1])
            srh[f'0_{depth}m_right_m2s2']=scalar(val[0])
    except Exception as exc: errors['kinematics']=str(exc)
    try:
        eff=params.effective_inflow_layer(prof,ecape=100,ecinh=-250)
        effective={'bottom_hpa':scalar(eff[0]),'top_hpa':scalar(eff[1])}
    except Exception as exc: effective=None;errors['effective_inflow']=str(exc)
    # Readout of temperature at specific AGL heights; lapse rates from native profile.
    lapse={}
    for bottom,upper in ((0,1000),(0,3000),(3000,6000),(700,3000)):
        if z[-1]>=upper:
            ta=np.interp(bottom,z,tc);tb=np.interp(upper,z,tc)
            lapse[f'{bottom}_{upper}m_c_km']=number((ta-tb)/(upper-bottom)*1000)
    adv,adv_error=inferred_advection(prof,float(raw.get('lat',35)))
    if adv_error: errors['inferred_advection']=adv_error
    ec_value,ec_error=ecape_value(a) if ecape else (None,'ECAPE skipped by request')
    if ec_error: errors['ecape']=ec_error
    try:
        pwat=scalar(params.precip_water(prof)) # inches SHARPpy convention
    except Exception as exc: pwat=None;errors['pwat']=str(exc)
    try:
        freezing_h=number(np.interp(0,tc[::-1],z[::-1])) if np.min(tc)<=0<=np.max(tc) else None
    except Exception: freezing_h=None
    return {
      'schema':'spcoa.hrrr_f00_sounding_diagnostics.v1','source':'native HRRR F00 profile',
      'location':{k:raw.get(k) for k in ('lat','lon','i','j')},
      'methods':{'ml':'Method B: 100-hPa pressure-integrated theta/mixing ratio; lifted from surface pressure',
                 'ecape':'Peters et al. 2023 via ecape.calc.calc_ecape',
                 'lcl_lfc_rh':'pressure-weighted environmental RH, surface-based LCL to LFC',
                 'advection':'SHARPpy inferred geostrophic thermal-wind advection (not actual horizontal advection)',
                 'barbs':'native U/V pressure-interpolated to every 50 hPa'},
      'ml_initial':ml_initial,'parcels':parcels,
      'peters_surface_ecape_jkg':ec_value,'sb_lcl_lfc_rh_percent':rh_layer,
      'wind_barbs_50hpa':wind_barbs(a),'inferred_advection_100hpa':adv,
      'bulk_shear':shear,'mean_winds':meanwinds,'storm_motions':motions,
      'storm_relative_helicity':srh,'effective_inflow':effective,
      'lapse_rates':lapse,'pwat_inches':pwat,'freezing_level_m_agl':freezing_h,
      'profile':{'pressure_hpa':p.tolist(),'temperature_c':tc.tolist(),
                 'dewpoint_c':dew.tolist(),'relative_humidity_percent':rh.tolist(),
                 'height_m_agl':z.tolist(), 'height_m_msl':a['height_m_msl'].tolist(),
                 'u_kt':(a['u_ms']*KTS_PER_MS).tolist(), 'v_kt':(a['v_ms']*KTS_PER_MS).tolist()},
      'warnings':(['Surface row combines 2m T/q with 10m winds and surface terrain height'] if a['surface_is_mixed_height'] else []),
      'calculation_errors':errors}

def get_s3_profile(run,lat,lon):
    # Reuses original archive's schema, coordinate indexing and binary decoder.
    import spcoa_soundings as archive
    client=archive.aws();bucket=archive.BUCKET
    base=archive.base_key(run)
    obj=lambda suffix:client.get_object(Bucket=bucket,Key=base+'/'+suffix)['Body'].read()
    manifest=json.loads(obj('manifest.json'))
    if not manifest.get('complete'):raise ValueError('Run not published')
    geo=json.loads(obj('geo_index.json'));anchors=np.asarray(geo['anchors'],float)
    dx=((anchors[:,3]-lon+180)%360)*np.cos(np.radians(lat))
    d=(anchors[:,2]-lat)**2+dx**2
    blocks=set()
    for idx in np.argsort(d)[:6]:
        j=int(anchors[idx,0])//archive.BLOCK;i=int(anchors[idx,1])//archive.BLOCK
        for dj in (-1,0,1):
            for di in (-1,0,1):
                if 0<=j+dj<math.ceil(archive.ROWS/archive.BLOCK) and 0<=i+di<math.ceil(archive.COLS/archive.BLOCK):
                    blocks.add(((j+dj)*archive.BLOCK,(i+di)*archive.BLOCK))
    best=None
    for j,i in blocks:
        tile=archive.decode_tile(gzip.decompress(obj(f'tiles/j{j:04d}/i{i:04d}.bin')))
        la=tile['lat_i1e5'];lo=tile['lon_i1e5'];dist=(la/1e5-lat)**2 + (((lo/1e5-lon+180)%360)-180)**2*np.cos(np.radians(lat))**2
        dist[la==archive.LATLON_FILL]=np.inf
        k=np.unravel_index(int(np.argmin(dist)),dist.shape)
        if np.isfinite(dist[k]) and (best is None or dist[k]<best[0]):best=(float(dist[k]),archive.decode_profile(tile,*k))
    if best is None:raise ValueError('No valid profile near requested location')
    return best[1]

def selftest():
    p=np.asarray([1000,950,900,850,800],float)
    v=np.asarray([300,310,320,330,340],float)
    assert abs(pressure_mean(p,v,900,1000)-310)<1e-9
    fake={k:[] for k in ('pressure_hpa','temperature_k','specific_humidity_kgkg','height_m_msl','u_ms','v_ms')}
    for i in range(40):
        fake['pressure_hpa'].append(1000-22*i)
        fake['temperature_k'].append(298-2.0*i)
        fake['specific_humidity_kgkg'].append(0.013*np.exp(-i/7))
        fake['height_m_msl'].append(400+i*225)
        fake['u_ms'].append(2+i*.6)
        fake['v_ms'].append(3+i*.2)
    a=prepare(fake); assert len(wind_barbs(a))>10
    print('SELFTEST PASS: profile validation, Method B pressure integration, 50-hPa barbs')

def main():
    cli=argparse.ArgumentParser(description=__doc__)
    sub=cli.add_subparsers(dest='command',required=True)
    sub.add_parser('selftest')
    prof=sub.add_parser('profile');prof.add_argument('--input',required=True)
    s3=sub.add_parser('s3');s3.add_argument('--run',required=True);s3.add_argument('--lat',type=float,required=True);s3.add_argument('--lon',type=float,required=True)
    for cmd in (prof,s3):
        cmd.add_argument('--output',required=True);cmd.add_argument('--skip-ecape',action='store_true')
    args=cli.parse_args()
    if args.command=='selftest':return selftest()
    raw=json.loads(Path(args.input).read_text()) if args.command=='profile' else get_s3_profile(args.run,args.lat,args.lon)
    result=diagnostics(raw,ecape=not args.skip_ecape)
    Path(args.output).write_text(json.dumps(result,indent=2,allow_nan=False))
    print('Wrote',args.output,'; diagnostics issues:',list(result['calculation_errors']))
if __name__=='__main__':main()
