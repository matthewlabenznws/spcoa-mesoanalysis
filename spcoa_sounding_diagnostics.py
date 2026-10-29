#!/usr/bin/env python3
"""SPCOA WeatherFront-inspired HRRR F00 sounding diagnostic engine (V4).

Reads native columns from spcoa_soundings.py v1 S3 tiles or a JSON profile.
Computes thermodynamics and SB/ML/MU Peters ECAPE from the selected profile; never substitutes gridded
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
import argparse, gzip, inspect, json, math
from pathlib import Path
import numpy as np

KTS_PER_MS = 1.94384449244
MAX_SELECTION_DISTANCE_KM = 30.0  # Reject unrelated map clicks / wrong lookup


def longitude_difference(lons, reference_lon):
    """Signed shortest longitude difference in degrees, in [-180, 180)."""
    return ((np.asarray(lons, dtype=float) - float(reference_lon) + 180.0) % 360.0) - 180.0


def first_freezing_level_m_agl(heights_agl, temperatures_c):
    """Lowest upward 0 C crossing (not interpolation across a nonmonotonic T array)."""
    z = np.asarray(heights_agl, dtype=float)
    t = np.asarray(temperatures_c, dtype=float)
    if len(z) != len(t) or len(z) < 2 or not np.isfinite(t[0]):
        return None
    if t[0] <= 0:
        return 0.0
    for k in range(1, len(t)):
        if (np.isfinite(t[k-1]) and np.isfinite(t[k]) and
                np.isfinite(z[k-1]) and np.isfinite(z[k]) and
                t[k-1] > 0 >= t[k] and z[k] > z[k-1]):
            f = t[k-1] / (t[k-1] - t[k])
            return number(z[k-1] + f * (z[k] - z[k-1]))
    return None

def json_safe(value):
    """Convert NumPy values to strict JSON-compatible Python values."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, (float, np.floating)):
        x = float(value)
        return x if math.isfinite(x) else None
    if isinstance(value, (np.integer, np.bool_)):
        return value.item()
    if isinstance(value, np.ndarray):
        return json_safe(value.tolist())
    if np.ma.is_masked(value):
        return None
    if isinstance(value, np.ma.MaskedArray):
        return json_safe(value.filled(np.nan).tolist())
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    raise TypeError(f"Cannot convert {type(value).__name__} to JSON")

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
        if arr['pressure_hpa'][i] < lastp-0.15 and arr['height_m_msl'][i] > arr['height_m_msl'][chosen[-1]]+0.01:
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

def lcl_lfc_rh_by_parcel(p, relative_humidity, parcel):
    """Return actual pressure-weighted environmental LCL-to-LFC RH, by parcel.

    The parcel's own LCL and LFC must define a positive-depth interval.
    With no valid LFC, return null instead of inventing an estimate.
    """
    if not parcel:
        return {'percent': None, 'status': 'parcel_unavailable'}
    lcl = parcel.get('lcl_hpa')
    lfc = parcel.get('lfc_hpa')
    if lcl is None or lfc is None:
        return {'percent': None, 'status': 'no_valid_lcl_lfc'}
    if lcl <= lfc + 0.01:
        return {'percent': None, 'status': 'zero_depth_or_inverted_layer'}
    value = number(pressure_mean(p, relative_humidity, lfc, lcl))
    return {'percent': value,
            'status': 'valid' if value is not None else 'insufficient_layer_data'}


def _ecape_with_parcel_bounds(a, cape_jkg, lfc_msl, el_msl):
    """Peters ECAPE assembled from public ecape.calc components.

    Used when the installed `ecape` release cannot accept user-supplied LFC,
    EL bounds. It preserves the Method B CAPE/LFC/EL parcel definition,
    rather than substituting MetPy's separate mixed-layer parcel. This route
    uses the ecape package's MSE -> NCAPE -> psi -> ECAPE components and
    its documented default right-moving 0-1-km storm-relative winds.
    """
    from ecape import calc as ec
    from metpy.units import units
    z = np.asarray(a['height_m_msl'], float)
    if not z[0] < lfc_msl < el_msl < z[-1]:
        raise ValueError('LFC/EL not within resolved HRRR vertical profile')
    p = a['pressure_hpa'] * units.hPa
    zm = z * units.meter
    t = a['temperature_k'] * units.kelvin
    q = a['specific_humidity_kgkg'] * units.dimensionless
    u = a['u_ms'] * units('m/s')
    v = a['v_ms'] * units('m/s')
    required = ('calc_mse', 'calc_integral_arg', 'calc_ncape',
                'calc_sr_wind', 'calc_psi', 'calc_ecape_a')
    missing = [name for name in required if not hasattr(ec, name)]
    if missing:
        raise RuntimeError('Installed ecape package lacks component functions: ' + ', '.join(missing))
    mse_bar, mse_star = ec.calc_mse(p, zm, t, q)
    arg = ec.calc_integral_arg(mse_bar, mse_star, t)
    # calc_ncape integrates from the last resolved level at/below LFC to
    # the last resolved level at/below EL (same bound convention as package).
    lfc_idx = int(np.searchsorted(z, lfc_msl, side='right') - 1)
    el_idx = int(np.searchsorted(z, el_msl, side='right') - 1)
    if el_idx <= lfc_idx:
        raise ValueError('LFC/EL separation is smaller than native vertical resolution')
    ncape = ec.calc_ncape(arg, zm, lfc_idx, el_idx).to('J/kg')
    # Peters NCAPE is a nonnegative dilution potential.
    if np.isfinite(ncape.magnitude) and ncape.magnitude < 0:
        ncape = 0.0 * units('J/kg')
    sr_wind = ec.calc_sr_wind(p, u, v, zm)
    psi = ec.calc_psi(el_msl * units.meter)
    value = ec.calc_ecape_a(sr_wind, psi, ncape,
                            cape_jkg * units('J/kg'))
    return value


def ecape_values(a, parcels, enabled=True):
    """Calculate SB, Method B ML and MU Peters ECAPE with independent status.

    No-LFC or zero CAPE parcels are not passed to `ecape.calc`, which can
    otherwise throw IndexError for empty positive-buoyancy arrays.
    """
    output = {}
    errors = {}
    if enabled:
        from ecape.calc import calc_ecape
        from metpy.units import units
        signature = inspect.signature(calc_ecape)
        supports_bounds = all(k in signature.parameters for k in ('lfc', 'el'))
        inputs = (a['height_m_msl'] * units.meter,
                  a['pressure_hpa'] * units.hPa,
                  a['temperature_k'] * units.kelvin,
                  a['specific_humidity_kgkg'] * units.dimensionless,
                  a['u_ms'] * units('m/s'), a['v_ms'] * units('m/s'))
    else:
        supports_bounds = False

    for name, package_name in [('sb','surface_based'),('ml','mixed_layer'),
                               ('mu','most_unstable')]:
        row = {'ecape_jkg':None, 'status':'not_calculated',
               'cape_type':package_name, 'calculation_method':None}
        parcel = parcels.get(name)
        if not enabled:
            row['status'] = 'skipped'
        elif not parcel:
            row['status'] = 'parcel_unavailable'
        else:
            cape = parcel.get('cape_jkg')
            lfc = parcel.get('lfc_m_agl')
            el = parcel.get('el_m_agl')
            if cape is None or lfc is None or el is None or cape <= 0:
                row['status'] = 'no_positive_cape_or_valid_lfc_el'
            elif not 0 <= lfc < el < float(a['height_m_agl'][-1]):
                row['status'] = 'invalid_or_unresolved_lfc_el'
            else:
                try:
                    # Use the exact selected parcel CAPE. This is vital for ML:
                    # SHARPpy Method B (pressure-integrated theta/mixing ratio)
                    # should not be silently swapped with MetPy's ML parcel.
                    kwargs = {'cape_type':package_name,
                              'undiluted_cape':float(cape)*units('J/kg')}
                    if supports_bounds:
                        kwargs.update({'lfc':(lfc + float(a['height_m_msl'][0])) * units.meter,
                                       'el':(el + float(a['height_m_msl'][0])) * units.meter})
                        result = calc_ecape(*inputs, **kwargs)
                        row['calculation_method'] = 'ecape.calc; SHARPpy parcel CAPE/LFC/EL overrides'
                    else:
                        # Published pip ecape releases may expose just
                        # cape_type and undiluted_cape, with no LFC/EL override.
                        # The component pathway is physically consistent with
                        # the selected parcel and avoids MetPy-ML LFC mismatch.
                        result = _ecape_with_parcel_bounds(
                            a, float(cape), lfc + float(a['height_m_msl'][0]),
                            el + float(a['height_m_msl'][0]))
                        row['calculation_method'] = 'ecape.calc components; SHARPpy parcel CAPE/LFC/EL'
                    value = scalar(result.to('J/kg').magnitude if hasattr(result,'to') else result)
                    if value is None or value < 0:
                        raise ValueError('ECAPE returned nonfinite or negative energy')
                    row.update({'ecape_jkg':value,'status':'valid'})
                except Exception as exc:
                    row['status'] = 'calculation_error'
                    errors[name] = f'{type(exc).__name__}: {exc}'
        output[name]=row
    return output, errors

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
    parcels={}; parcel_objects={}; errors={}
    for name,flag in [('sb',1),('mu',3)]:
        try:
            parcel=params.parcelx(prof,flag=flag)
            parcels[name]=parcel_report(parcel)
            parcel_objects[name]=parcel
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
            parcel_objects['ml']=pc
        except Exception as exc: errors['ml']=str(exc);parcels['ml']=None
    else: errors['ml']='Insufficient complete 100-hPa mixed layer';parcels['ml']=None
    # RH uses each lifted parcel's own LCL and LFC. Undefined LFC stays null.
    lcl_lfc_rh = {kind:lcl_lfc_rh_by_parcel(p,rh,parcels.get(kind))
                  for kind in ('sb','ml','mu')}

    # V4: fixed-height BWD / mean SRW / SRH by layer. All heights are AGL.
    # SRH is computed relative to the selected Bunkers right-moving storm motion;
    # positive/negative helicity components are preserved by SHARPpy internally.
    layers=((0,500),(0,1000),(0,3000),(0,6000),(0,9000),
            (1000,3000),(3000,6000))
    shear={}; meanwinds={}; srw={}
    surface=np.asarray([a['u_ms'][0],a['v_ms'][0]],float)
    for bot,topz in layers:
        if z[-1] < topz or z[0] > bot: continue
        wind_bot=np.asarray([np.interp(bot,z,a['u_ms']),np.interp(bot,z,a['v_ms'])])
        wind_top=np.asarray([np.interp(topz,z,a['u_ms']),np.interp(topz,z,a['v_ms'])])
        shear[f'{bot}_{topz}m_kt']=number(np.linalg.norm(wind_top-wind_bot)*KTS_PER_MS)
        avg=layer_uv(a,bot,topz)
        meanwinds[f'{bot}_{topz}m']={'u_kt':number(avg[0]*KTS_PER_MS),
                                    'v_kt':number(avg[1]*KTS_PER_MS)} if avg is not None else None
    # Bunkers parcel-based motion with documented nonparcel fallback.
    motions={};srh={}
    mr=None
    try:
        from sharppy.sharptab import winds
        bm=params.bunkers_storm_motion(prof)
        motion_method='effective_inflow_parcel_based'
        if len(bm)<4 or any(scalar(x) is None for x in bm[:4]):
            bm=winds.non_parcel_bunkers_motion(prof)
            motion_method='standard_nonparcel_bunkers_fallback'
        rm, lm = bm[:2],bm[2:4]
        motions={'method':motion_method,
                 'right':{'u_kt':scalar(rm[0]),'v_kt':scalar(rm[1])},
                 'left':{'u_kt':scalar(lm[0]),'v_kt':scalar(lm[1])}}
        if all(scalar(x) is not None for x in rm):
            mr=(float(rm[0]),float(rm[1]))
            for bot,topz in layers:
                if z[-1] < topz: continue
                val=winds.helicity(prof,bot,topz,stu=rm[0],stv=rm[1])
                srh[f'{bot}_{topz}m_right_m2s2']=scalar(val[0])
                avg=meanwinds.get(f'{bot}_{topz}m')
                if avg and all(avg.get(k) is not None for k in ('u_kt','v_kt')):
                    srw[f'{bot}_{topz}m_right_kt']=number(math.hypot(avg['u_kt']-mr[0],avg['v_kt']-mr[1]))
        else:
            errors['kinematics']='Both parcel-based and standard Bunkers motions were unavailable'
    except Exception as exc: errors['kinematics']=str(exc)
    # Pressure-defined effective inflow depth and its true AGL bounds.
    effective=None;effective_srh=None;effective_bwd_kt=None
    try:
        eff=params.effective_inflow_layer(prof,ecape=100,ecinh=-250)
        eff_pbot=scalar(eff[0]);eff_ptop=scalar(eff[1])
        if (eff_pbot is not None and eff_ptop is not None and
                p[-1]<=eff_ptop<eff_pbot<=p[0]):
            ebot_z=number(np.interp(eff_pbot,p[::-1],z[::-1]))
            etop_z=number(np.interp(eff_ptop,p[::-1],z[::-1]))
            effective={'bottom_hpa':eff_pbot,'top_hpa':eff_ptop,
                       'bottom_m_agl':ebot_z,'top_m_agl':etop_z}
            if mr and all(x is not None for x in (ebot_z,etop_z)):
                effective_srh=scalar(winds.helicity(prof,ebot_z,etop_z,
                                                    stu=mr[0],stv=mr[1])[0])
                srh['effective_right_m2s2']=effective_srh
            # Effective BWD uses EIL base to halfway through the MU storm depth.
            # Define storm depth as EIL base -> MU equilibrium level AGL.
            mu_el=parcels.get('mu',{}).get('el_m_agl') if parcels.get('mu') else None
            if mu_el is not None and ebot_z is not None and mu_el>ebot_z:
                mid_z=ebot_z+.5*(mu_el-ebot_z)
                if mid_z <= z[-1]:
                    low_uv=np.asarray([np.interp(ebot_z,z,a['u_ms']),np.interp(ebot_z,z,a['v_ms'])]);
                    mid_uv=np.asarray([np.interp(mid_z,z,a['u_ms']),np.interp(mid_z,z,a['v_ms'])]);
                    effective_bwd_kt=number(np.linalg.norm(mid_uv-low_uv)*KTS_PER_MS)
                    effective['effective_bwd_kt']=effective_bwd_kt
                    effective['effective_bwd_top_m_agl']=number(mid_z)
        else:
            effective={'bottom_hpa':eff_pbot,'top_hpa':eff_ptop,
                       'bottom_m_agl':None,'top_m_agl':None}
    except Exception as exc: errors['effective_inflow']=str(exc)
    # SHARPpy/SPC-style composite indices. No tornado probabilities or
    # categorical hazards are inferred; missing prerequisites remain null.
    composites={k:None for k in ('scp','stp_cin','stp_fixed','ehi_0_1km',
                                  'ehi_0_3km','ship','brn_mu')}
    def metric(label,callback):
        try: composites[label]=scalar(callback())
        except Exception as exc: errors['composite_'+label]=str(exc)
    sb=parcels.get('sb') or {};ml=parcels.get('ml') or {};mu=parcels.get('mu') or {}
    composites['brn_mu']=scalar(getattr(parcel_objects.get('mu'),'brn',None))
    if mu.get('cape_jkg') is not None and mu['cape_jkg']>0:
        metric('ship',lambda:params.ship(prof,mupcl=parcel_objects['mu']))
    if mr:
        if sb.get('cape_jkg') is not None:
            for topz,label in ((1000,'ehi_0_1km'),(3000,'ehi_0_3km')):
                hval=srh.get(f'0_{topz}m_right_m2s2')
                if hval is not None:
                    composites[label]=number(sb['cape_jkg']*hval/160000.)
        if all(v is not None for v in (sb.get('cape_jkg'),sb.get('lcl_m_agl'),
                   srh.get('0_1000m_right_m2s2'),shear.get('0_6000m_kt'))):
            metric('stp_fixed',lambda:params.stp_fixed(sb['cape_jkg'],sb['lcl_m_agl'],
                 srh['0_1000m_right_m2s2'],shear['0_6000m_kt']/KTS_PER_MS))
    if effective_srh is not None and effective_bwd_kt is not None:
        eff_bwd_ms=effective_bwd_kt/KTS_PER_MS
        if mu.get('cape_jkg') is not None:
            metric('scp',lambda:params.scp(mu['cape_jkg'],effective_srh,eff_bwd_ms))
        if all(ml.get(k) is not None for k in ('cape_jkg','lcl_m_agl','cin_jkg')):
            metric('stp_cin',lambda:params.stp_cin(ml['cape_jkg'],effective_srh,
                   eff_bwd_ms,ml['lcl_m_agl'],ml['cin_jkg']))
    # Readout of temperature at specific AGL heights; lapse rates from native profile.
    lapse={}
    for bottom,upper in ((0,1000),(0,3000),(3000,6000),(700,3000)):
        if z[-1]>=upper:
            ta=np.interp(bottom,z,tc);tb=np.interp(upper,z,tc)
            lapse[f'{bottom}_{upper}m_c_km']=number((ta-tb)/(upper-bottom)*1000)
    adv,adv_error=inferred_advection(prof,float(raw.get('lat',35)))
    if adv_error: errors['inferred_advection']=adv_error
    ecape_data,ecape_errors=ecape_values(a,parcels,enabled=ecape)
    if ecape_errors: errors['ecape']=ecape_errors
    try:
        pwat=scalar(params.precip_water(prof)) # inches SHARPpy convention
    except Exception as exc: pwat=None;errors['pwat']=str(exc)
    freezing_h=first_freezing_level_m_agl(z,tc)
    return {
      'schema':'spcoa.hrrr_f00_sounding_diagnostics.v2','source':'native HRRR F00 profile',
      'location':{k:raw.get(k) for k in ('lat','lon','i','j')},
      'run_id':raw.get('run_id'),
      'requested_location':{'lat':raw.get('requested_lat'),'lon':raw.get('requested_lon')},
      'selection_distance_km':raw.get('selection_distance_km'),
      'methods':{'ml':'Method B: 100-hPa pressure-integrated theta/mixing ratio; lifted from surface pressure',
                 'ecape':'Peters et al. 2023: SB, 100-hPa Method B ML, MU; SHARPpy parcel CAPE/LFC/EL, ecape package calculation',
                 'lcl_lfc_rh':'pressure-weighted environmental RH from each SB/ML/MU parcel LCL to LFC',
                 'advection':'SHARPpy inferred geostrophic thermal-wind advection (not actual horizontal advection)',
                 'srh':'SHARPpy right-moving Bunkers storm-relative helicity at fixed AGL layers',
                 'composites':'SHARPpy-style SCP/STP/SHIP/EHI; effective BWD from EIL base to half MU storm depth',
                 'barbs':'native U/V pressure-interpolated to every 50 hPa'},
      'ml_initial':ml_initial,'parcels':parcels,
      'peters_surface_ecape_jkg':ecape_data['sb']['ecape_jkg'],
      'peters_ml_ecape_jkg':ecape_data['ml']['ecape_jkg'],
      'peters_mu_ecape_jkg':ecape_data['mu']['ecape_jkg'],
      'ecape_by_parcel':ecape_data,
      'sb_lcl_lfc_rh_percent':lcl_lfc_rh['sb']['percent'],
      'sb_lcl_lfc_rh_status':lcl_lfc_rh['sb']['status'],
      'ml_lcl_lfc_rh_percent':lcl_lfc_rh['ml']['percent'],
      'ml_lcl_lfc_rh_status':lcl_lfc_rh['ml']['status'],
      'mu_lcl_lfc_rh_percent':lcl_lfc_rh['mu']['percent'],
      'mu_lcl_lfc_rh_status':lcl_lfc_rh['mu']['status'],
      'lcl_lfc_rh_by_parcel':lcl_lfc_rh,
      'wind_barbs_50hpa':wind_barbs(a),'inferred_advection_100hpa':adv,
      'bulk_shear':shear,'mean_winds':meanwinds,'storm_motions':motions,
      'storm_relative_helicity':srh,'storm_relative_wind':srw,
      'effective_inflow':effective,'composites':composites,
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
    dx=longitude_difference(anchors[:,3],lon)*np.cos(np.radians(lat))
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
        la=tile['lat_i1e5'];lo=tile['lon_i1e5'];dist=(la/1e5-lat)**2 + longitude_difference(lo/1e5,lon)**2*np.cos(np.radians(lat))**2
        dist[la==archive.LATLON_FILL]=np.inf
        k=np.unravel_index(int(np.argmin(dist)),dist.shape)
        if np.isfinite(dist[k]) and (best is None or dist[k]<best[0]):best=(float(dist[k]),archive.decode_profile(tile,*k))
    if best is None:raise ValueError('No valid profile near requested location')
    dist_km=math.sqrt(best[0])*111.2  # equirectangular km; accurate for nearby cells
    if dist_km>MAX_SELECTION_DISTANCE_KM:
        raise ValueError(f'Nearest HRRR cell is {dist_km:.1f} km from requested '
                         f'{lat:.4f}, {lon:.4f}; refusing wrong-location sounding')
    selected=best[1]
    selected.update({'requested_lat':float(lat),'requested_lon':float(lon),
                     'selection_distance_km':number(dist_km),'run_id':run})
    print(f'Selected HRRR native cell j={selected["j"]} i={selected["i"]}: '
          f'{selected["lat"]:.5f}, {selected["lon"]:.5f} '
          f'({dist_km:.2f} km from request)')
    return selected

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
    # Regression: old longitude lookup picked the Pacific instead of Nebraska.
    anchor_lons=np.array([-129.97058,-100.70,-99.90])
    diffs=longitude_difference(anchor_lons,-100.69)
    assert np.argmin(abs(diffs))==1
    assert abs(diffs[0]+29.28058)<1e-5
    assert lcl_lfc_rh_by_parcel([1000,950,900], [30,40,50],
        {'lcl_hpa':950,'lfc_hpa':900}) == {'percent':45.0, 'status':'valid'}
    assert lcl_lfc_rh_by_parcel([1000,950,900],[30,40,50],
        {'lcl_hpa':950,'lfc_hpa':None})['status']=='no_valid_lcl_lfc'
    assert abs(float(longitude_difference(179.0,-179.0))+2.0)<1e-8
    assert first_freezing_level_m_agl([0,1000,2000],[5,-5,-10])==500.0
    encoded=json.dumps(json_safe({'i':np.int64(12),'value':np.float32(1.5),
                                   'missing':np.float64(np.nan),
                                   'barbs':np.array([950,900],dtype=np.int64)}),allow_nan=False)
    assert json.loads(encoded)=={'i':12,'value':1.5,'missing':None,'barbs':[950,900]}
    print('SELFTEST PASS: profiles, Method B integration, SB/ML/MU RH, wind barbs, longitude, JSON (V4)')

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
    Path(args.output).write_text(json.dumps(json_safe(result),indent=2,allow_nan=False))
    print('Wrote',args.output,'; diagnostics issues:',list(result['calculation_errors']))
    for kind in ('sb','ml','mu'):
        er = result['ecape_by_parcel'][kind]
        rh = result['lcl_lfc_rh_by_parcel'][kind]
        print(f'  {kind.upper()}: ECAPE={er["ecape_jkg"]} J/kg [{er["status"]}], '
              f'LCL-LFC RH={rh["percent"]}% [{rh["status"]}]')
if __name__=='__main__':main()
