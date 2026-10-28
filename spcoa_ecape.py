#!/usr/bin/env python3
"""SPCOA surface-based ECAPE: full native HRRR CONUS F00.

Separate from spcoa_analysis.py. The sharded 'compute' job calculates every
native horizontal HRRR gridpoint (stride 1) at 100 m AGL resolution using an
optimized numerical port of the supplied Peters-style CAM ECAPE routines.
The 'publish' job assembles all stripes and writes 256x256 uint16 XYZ tiles.
It never overwrites spcoa/latest.json, the primary run manifest, or existing
SPCOA products. ECAPE is optional per-run metadata.

The original user's CAM script is the scientific reference. Validate numeric
agreement of a set of soundings before production: this is a performance port,
not a bit-for-bit execution of the original Python routines.
"""
from __future__ import annotations
import argparse
import io
import json
import math
import os
import pathlib
import sys
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

BUCKET = os.environ.get('SPCOA_ECAPE_BUCKET', 'spcoa-mesoanalysis')
PREFIX = os.environ.get('SPCOA_ECAPE_PREFIX', 'spcoa')
REGION = os.environ.get('AWS_DEFAULT_REGION', 'us-east-2')
PART_DIR = pathlib.Path(os.environ.get('SPCOA_ECAPE_WORKDIR', 'ecape_work'))
GRID_ROWS, GRID_COLS = 1059, 1799
DZ = 100.0
TOP = 20000.0
NVERT = int(TOP / DZ)
MIXING_LENGTH = 250.0
T_WARM, T_COLD = 273.15, 253.15
ZOOMS = (4, 5, 6, 7)
TILE_SIZE = 256
NO_DATA = 65535


def s3client():
    import boto3
    return boto3.client('s3', region_name=REGION)


def s3key(run, tail):
    return f'{PREFIX}/runs/{run}/{tail}'


def resolve_run(optional_run='', force=False):
    s3 = s3client()
    if optional_run:
        run = optional_run
        # Verify main analysis run exists, preventing unconnected HRRR cycles.
        s3.head_object(Bucket=BUCKET, Key=s3key(run, 'metadata.json'))
    else:
        doc = json.loads(s3.get_object(Bucket=BUCKET, Key=f'{PREFIX}/latest.json')['Body'].read())
        run = doc['run']
    datetime.strptime(run, '%Y%m%d_%H')
    exists = False
    try:
        s3.head_object(Bucket=BUCKET, Key=s3key(run, 'ecape/metadata.json'))
        exists = True
    except s3.exceptions.ClientError as exc:
        if exc.response.get('ResponseMetadata', {}).get('HTTPStatusCode') not in (403, 404):
            raise
        if exc.response.get('ResponseMetadata', {}).get('HTTPStatusCode') == 403:
            raise
    result = {'run': run, 'skip': exists and not force, 'existing': exists}
    print(json.dumps(result))
    return result


# ---------- Numba-compiled Peters-style thermodynamic functions ----------
# These follow the constants/definitions of the CAM user's original Python
# functions compute_rsat, drylift, moislif, compute_CAPE_AND_CIN,
# compute_NCAPE, compute_VSR, and compute_ETILDE.
from numba import njit, prange

@njit(cache=True)
def rsat(T, p, kind):
    if T <= 120.0 or p <= 0.0 or not math.isfinite(T + p):
        return math.nan
    cpv, cpl, cpi, rv, trip = 1870., 4190., 2106., 461.5, 273.15
    eps = 287.04 / rv
    a = (cpv - cpl) / rv
    b = (2501000. - trip * (cpv - cpl)) / rv
    e_liq = 611.2 * math.exp((T - trip)*b/(T*trip)) * (T/trip)**a
    a = (cpv - cpi) / rv
    b = (2834000. - trip * (cpv - cpi)) / rv
    e_ice = 611.2 * math.exp((T - trip)*b/(T*trip)) * (T/trip)**a
    e_liq = min(e_liq, p*.5)
    e_ice = min(e_ice, p*.5)
    rl = eps * e_liq / (p - e_liq)
    ri = eps * e_ice / (p - e_ice)
    if kind == 0: return rl
    if kind == 2: return ri
    w = max(0., min(1., (T-273.15)/(253.15-273.15)))
    return (1.-w)*rl + w*ri


@njit(cache=True)
def dry_lapse(T, q, Te, qe):
    rd, rv, cp, cpv, g = 287.04, 461.5, 1005., 1870., 9.81
    cpm = (1.-q)*cp + q*cpv
    B = g*((T-Te)/Te + (rv/rd-1.)*(q-qe))
    return -(g+B)/cpm


@njit(cache=True)
def moist_lapse(T, qv, qt, p, Te, qe):
    rd, rv, cp, g = 287.04, 461.5, 1005., 9.81
    cpv, cpl, cpi, Lv0, Ls0, trip = 1870., 4190., 2106., 2501000., 2834000., 273.15
    eps = rd/rv
    w = max(0., min(1., (T-trip)/(253.15-trip)))
    dw = 1./(253.15-trip) if 253.15 < T < trip else 0.
    qt = max(0., qt); qv = max(0., qv)
    cpm = (1.-qt)*cp + qv*cpv + (1.-w)*(qt-qv)*cpl + w*(qt-qv)*cpi
    Lv = Lv0 + (T-trip)*(cpv-cpl)
    Li = Ls0-Lv0 + (T-trip)*(cpl-cpi)
    Rm0 = (1.-qe)*rd + qe*rv
    Tr = T*(1.-qt + qv/eps)
    Tre = Te*(1.-qe + qe/eps)
    B = g*(Tr-Tre)/Tre
    qsl = (1.-qt)*rsat(T, p, 0)
    qsi = (1.-qt)*rsat(T, p, 2)
    den_l = 1. - qsl/(eps-eps*qt+qv)
    den_i = 1. - qsi/(eps-eps*qt+qv)
    if den_l <= 0. or den_i <= 0.: return math.nan
    qm = (1.-w)*qsl/den_l + w*qsi/den_i
    lm = Lv*(1.-w)*qsl/den_l + (Lv+Li)*w*qsi/den_i
    num = -B - qm*(Lv+Li*w)*g/(Rm0*Te) - g
    den = cpm - Li*(qt-qv)*dw + (Lv+Li*w)*(-dw*(qsl-qsi)+lm/(rv*T*T))
    return num/den if den > 0. else math.nan


@njit(cache=True)
def profile_ecape(Te, p, qe, u, v, z, Bbuf, Mbuf):
    n = len(Te); rd=287.04; rv=461.5; g=9.81; cp=1005.; Lv=2501000.
    # This follows the CAM script's early-stop rule (B_run + 250 J/kg).
    min_idx=0; min_mse=1e30
    for k in range(n):
        mse=cp*Te[k]+Lv*qe[k]+g*z[k]
        Mbuf[k]=mse
        if mse<min_mse: min_mse=mse; min_idx=k
        Bbuf[k]=math.nan
    T=Te[0]; q=qe[0]; qt=q; Brun=0.; qsatprev=0.
    Bbuf[0]=0.
    last=0
    for k in range(1, n):
        if k > min_idx and Brun+250. <= 0.: break
        dz=z[k]-z[k-1]
        oldT=T; oldq=q
        qsat=(1.-qt)*rsat(T, p[k-1], 1)
        if not math.isfinite(qsat): break
        if q < qsat:
            T += dz*dry_lapse(T,q,Te[k-1],qe[k-1])
            # fracent=0, prate=0 in the original undiluted CAPE calculation
            qsatnew=(1.-qt)*rsat(T,p[k],1)
            if q >= qsatnew:
                denom=qsatnew-qsatprev
                frac=(q-qsatprev)/denom if abs(denom)>1e-14 else 0.
                frac=max(0., min(1., frac))
                dry=frac*dz; wet=(1.-frac)*dz
                Th=oldT+dry*dry_lapse(oldT,oldq,Te[k-1],qe[k-1])
                ph=p[k-1]*frac+p[k]*(1.-frac)
                eTh=Te[k-1]*frac+Te[k]*(1.-frac)
                eQh=qe[k-1]*frac+qe[k]*(1.-frac)
                lapse=moist_lapse(Th,q,qt,ph,eTh,eQh)
                if not math.isfinite(lapse): break
                T=Th+wet*lapse
                q=min(qt,(1.-qt)*rsat(T,p[k],1))
            qsatprev=qsatnew
        else:
            lapse=moist_lapse(T,q,qt,p[k-1],Te[k-1],qe[k-1])
            if not math.isfinite(lapse): break
            T += dz*lapse
            q=min(qt,(1.-qt)*rsat(T,p[k],1))
        if not math.isfinite(T+q) or T < 125. or T > 360.: break
        Tr=T*(1.+(rv/rd)*q-qt)
        Tr0=Te[k]*(1.+(rv/rd-1.)*qe[k])
        b=g*(Tr-Tr0)/Tr0
        Bbuf[k]=b
        Brun+=b*dz
        last=k
    # CAPE, positive buoyancy, last positive EL, LFC immediately preceding max B.
    imax=-1; maxB=0.; el_i=-1; cape=0.
    for k in range(1,last+1):
        b=Bbuf[k]
        if b>0.:
            if b>maxB: maxB=b; imax=k
            el_i=k
        b0=Bbuf[k-1]
        if math.isfinite(b0) and math.isfinite(b):
            cape += .5*(max(0.,b0)+max(0.,b))*(z[k]-z[k-1])
    if cape<=0. or imax<0 or el_i<1: return 0.
    lfc_i=0
    for k in range(1,imax):
        if Bbuf[k]<0.: lfc_i=k
    if lfc_i>0: lfc_i=min(lfc_i+1,n-1)
    # The original CAM script defines EL at the midpoint around last B>0.
    el=.5*(z[el_i]+z[min(el_i+1,n-1)])
    if el<=0.: return math.nan
    # Source compute_NCAPE: MSEbar and saturation MSEstar.
    # Preserve the source's original qsat=(1-rsat)*rsat expression to
    # facilitate side-by-side validation; see README scientific caveat.
    sum_mse=0.; ncape=0.
    prev_arg=0.
    for k in range(n):
        if k>0: sum_mse += .5*(Mbuf[k-1]+Mbuf[k])*(z[k]-z[k-1])
        mean_mse = Mbuf[0] if k==0 else sum_mse/(z[k]-z[0])
        r=rsat(Te[k],p[k],0)
        qs=(1.-r)*r
        mse_star=cp*Te[k]+Lv*qs+g*z[k]
        arg=-(g/(cp*Te[k]))*(mean_mse-mse_star)
        if lfc_i<k<=el_i: ncape+=.5*(arg+prev_arg)*(z[k]-z[k-1])
        prev_arg=arg
    ncape=max(0.,ncape)
    # compute_VSR from original: Bunkers 0-6 km mean, 0-500 m and 5.5-6 km shear
    meanu=0.; meanv=0.; lowu=0.; lowv=0.; highu=0.; highv=0.
    nmean=0; nlow=0; nhigh=0
    for k in range(n):
        if z[k]<=6000.: meanu+=u[k];meanv+=v[k];nmean+=1
        if z[k]<=500.: lowu+=u[k];lowv+=v[k];nlow+=1
        if 5500.<=z[k]<=6000.: highu+=u[k];highv+=v[k];nhigh+=1
    if min(nmean,nlow,nhigh)==0: return math.nan
    meanu/=nmean;meanv/=nmean; lowu/=nlow;lowv/=nlow;highu/=nhigh;highv/=nhigh
    du=highu-lowu; dv=highv-lowv; mag=math.hypot(du,dv)
    if mag<1e-5: return math.nan
    cx=meanu+7.5*dv/mag; cy=meanv-7.5*du/mag
    vsr=0.; nsr=0
    for k in range(n):
        if z[k]<=1000.: vsr+=math.hypot(u[k]-cx,v[k]-cy);nsr+=1
    vsr/=nsr
    # compute_ETILDE: original parameters, guarded when v_sr or CAPE ~ 0.
    pitch = .18*(.8**2)*(math.pi**2)*MIXING_LENGTH/(4.*(1./3.)*(1.1**2)*el)
    vs2=vsr*vsr/(2.*cape)
    if vs2<1e-10 or pitch<=0.: return math.nan
    nt=ncape/cape
    aa=pitch/vs2
    disc=(1.+pitch+aa*nt)**2+4.*aa*(1.-pitch*nt)
    if disc<0.: return math.nan
    et=vs2+(-1.-pitch-aa*nt+math.sqrt(disc))/(2.*aa)
    return max(0.,et*cape) if math.isfinite(et) else math.nan


@njit(parallel=True,cache=True)
def compute_strip(surface, prs, plevels):
    # surface shape (6, npoints): temperature2m, humidity2m, pressure,
    # terrain MSL, u10, v10. prs shape (5, levels, npoints)
    npts=surface.shape[1]; out=np.empty(npts,dtype=np.float32)
    z=np.arange(NVERT,dtype=np.float64)*DZ
    for ip in prange(npts):
        out[ip]=np.nan
        p_s=surface[2,ip]; h_s=surface[3,ip]
        if not (math.isfinite(p_s+h_s+surface[0,ip]+surface[1,ip]) and 4e4<p_s<1.1e5):
            continue
        # Build strictly upward sounding, selecting only valid pressure levels.
        nlev=prs.shape[1]
        heights=np.empty(nlev+1,np.float64)
        pp=np.empty(nlev+1,np.float64); tt=np.empty(nlev+1,np.float64)
        qq=np.empty(nlev+1,np.float64); uu=np.empty(nlev+1,np.float64); vv=np.empty(nlev+1,np.float64)
        heights[0]=0.;pp[0]=p_s;tt[0]=surface[0,ip];qq[0]=surface[1,ip]
        uu[0]=surface[4,ip];vv[0]=surface[5,ip]; count=1
        for l in range(nlev):
            ph=plevels[l]*100.
            h=prs[0,l,ip]-h_s
            if ph >= pp[count-1]-.1 or h <= heights[count-1]+.1: continue
            if not math.isfinite(prs[0,l,ip]+prs[1,l,ip]+prs[2,l,ip]+prs[3,l,ip]+prs[4,l,ip]):continue
            heights[count]=h;pp[count]=ph;tt[count]=prs[1,l,ip]
            qq[count]=min(.05,max(0.,prs[2,l,ip]));uu[count]=prs[3,l,ip];vv[count]=prs[4,l,ip]
            count+=1
        if count<5 or heights[count-1]<16000.: continue
        T=np.empty(NVERT,np.float64);p=np.empty(NVERT,np.float64)
        q=np.empty(NVERT,np.float64);u=np.empty(NVERT,np.float64);v=np.empty(NVERT,np.float64)
        il=0
        for k in range(NVERT):
            zz=z[k]
            while il<count-2 and heights[il+1]<zz: il+=1
            w=(zz-heights[il])/(heights[il+1]-heights[il])
            T[k]=tt[il]+w*(tt[il+1]-tt[il]);q[k]=max(0.,min(.05,qq[il]+w*(qq[il+1]-qq[il])))
            u[k]=uu[il]+w*(uu[il+1]-uu[il]);v[k]=vv[il]+w*(vv[il+1]-vv[il])
            p[k]=math.exp(math.log(pp[il])+w*(math.log(pp[il+1])-math.log(pp[il])))
        Bbuf=np.empty(NVERT,np.float64);Mbuf=np.empty(NVERT,np.float64)
        out[ip]=profile_ecape(T,p,q,u,v,z,Bbuf,Mbuf)
    return out


def first_da(result, preferred):
    import xarray as xr
    if isinstance(result,list):
        result=xr.merge(result,compat='override',join='outer')
    if isinstance(result,xr.DataArray): return result.squeeze()
    for candidate in preferred:
        if candidate in result.data_vars: return result[candidate].squeeze()
    vars_=[x for x in result.data_vars if x not in ('gribfile_projection','metpy_crs')]
    if len(vars_)!=1: raise ValueError(f'Ambiguous GRIB variables: {vars_}')
    return result[vars_[0]].squeeze()


def load_hrrr_strip(run,start,stop):
    from herbie import Herbie
    dt=datetime.strptime(run,'%Y%m%d_%H')
    sources={p:Herbie(dt,model='hrrr',product=p,fxx=0,priority=['aws','google'],verbose=False) for p in ('sfc','prs')}
    def field(product,search,preferred):
        print(f'HRRR {product}: {search}',flush=True)
        da=first_da(sources[product].xarray(search,remove_grib=True), preferred)
        indexers={k:slice(start,stop) for k in da.dims if k=='y'}
        # Read only the shard's native rows; no horizontal interpolation.
        return da.isel(**indexers)
    specifications=[
        ('sfc',r':TMP:2 m', ['t2m','t']),
        ('sfc',r':SPFH:2 m',['sh2','q','spfh']),
        ('sfc',r':PRES:surface',['sp','pres']),
        ('sfc',r':HGT:surface',['orog','gh','hgt']),
        ('sfc',r':UGRD:10 m',['u10','u']),
        ('sfc',r':VGRD:10 m',['v10','v']),
    ]
    surf=[field(*x) for x in specifications]
    ydim,x_dim=surf[0].sizes['y'],surf[0].sizes['x']
    # Preserve exact HRRR Lambert grid coords for the publisher.
    x=np.asarray(surf[0].coords['x'].values,dtype=np.float64)
    y=np.asarray(surf[0].coords['y'].values,dtype=np.float64)
    # Guard against silent longitude/latitude shifts if HRRR changes its grid.
    da0=surf[0]
    if 'latitude' in da0.coords and 'longitude' in da0.coords:
        iy=len(y)//2;ix=len(x)//2
        true_lat=float(da0.latitude.values[iy,ix])
        true_lon=float(da0.longitude.values[iy,ix])
        tx,ty=source_projection().transform(true_lon,true_lat)
        error=math.hypot(tx-x[ix],ty-y[iy])
        if error>10000.:
            raise RuntimeError(f'HRRR grid/projection mismatch: {error:.0f} metres; refusing misplaced ECAPE tiles')
    pvars=[
        ('prs',r':HGT:[0-9]+ mb:',['gh','hgt']),
        ('prs',r':TMP:[0-9]+ mb:',['t','tmp']),
        ('prs',r':SPFH:[0-9]+ mb:',['q','spfh']),
        ('prs',r':UGRD:[0-9]+ mb:',['u','ugrd']),
        ('prs',r':VGRD:[0-9]+ mb:',['v','vgrd']),
    ]
    press=[field(*s) for s in pvars]
    def pressure_name(da):
        for key in ('isobaricInhPa','isobaricInPa','pressure','level'):
            if key in da.coords: return key
        raise RuntimeError(f'Pressure coordinate missing: {da.coords}')
    pressure_lists=[]
    for da in press:
        key=pressure_name(da)
        levels=np.asarray(da.coords[key].values,dtype=float)
        if levels.max()>2000:levels/=100.
        pressure_lists.append(np.round(levels,5))
    common=sorted(set(pressure_lists[0]).intersection(*[set(x) for x in pressure_lists[1:]]),reverse=True)
    # Keep levels through 50 hPa to cover the 20-km AGL source profile.
    common=[p for p in common if 50.<=p<=1100.]
    if len(common)<15:raise RuntimeError(f'Insufficient common HRRR pressure levels: {common}')
    s_arr=np.stack([np.asarray(da.values,dtype=np.float32).reshape(-1) for da in surf])
    cols=[]
    for da, plev in zip(press,pressure_lists):
        key=pressure_name(da)
        arr=np.asarray(da.values,dtype=np.float32)
        levaxis=da.dims.index(key)
        arr=np.moveaxis(arr,levaxis,0)
        take=np.array([int(np.where(plev==p)[0][0]) for p in common],dtype=int)
        cols.append(arr[take].reshape((len(common),-1)))
    pr_arr=np.stack(cols)
    if s_arr.shape[1] != ydim*x_dim or pr_arr.shape[2]!=ydim*x_dim:
        raise ValueError('Field dimension mismatch; aborting rather than shifting grid')
    return s_arr,pr_arr,np.asarray(common,dtype=np.float64),x,y


def compute(run,shard,shards):
    if not 0<=shard<shards:raise ValueError('invalid shard')
    # Entire HRRR CONUS, no latitude/longitude bounding mask or stride.
    start=GRID_ROWS*shard//shards
    stop=GRID_ROWS*(shard+1)//shards
    surface,prs,levels,x,y=load_hrrr_strip(run,start,stop)
    if len(x)!=GRID_COLS or len(y)!=stop-start:raise RuntimeError('HRRR grid dimensions changed')
    print(f'Calculating native 3-km ECAPE {run}: shard {shard}/{shards}, rows {start}:{stop}, {surface.shape[1]:,} soundings',flush=True)
    ecape=compute_strip(surface,prs,levels).reshape(stop-start,GRID_COLS)
    finite=ecape[np.isfinite(ecape)]
    print(f'Calculated {finite.size:,}/{ecape.size:,} finite. Range: {np.nanmin(finite) if finite.size else "none"} to {np.nanmax(finite) if finite.size else "none"}',flush=True)
    if finite.size < 0.5*ecape.size:raise RuntimeError('Excessive missing ECAPE values; refusing partial national publication')
    PART_DIR.mkdir(parents=True,exist_ok=True)
    name=PART_DIR/f'ecape_shard_{shard:02d}.npz'
    # Include native Lambert x and y (metres) for authoritative georeferencing.
    np.savez_compressed(name,ecape=ecape.astype(np.float32),start=np.int32(start),stop=np.int32(stop),x=x,y=y,run=np.array(run))
    print(f'Saved {name} ({name.stat().st_size:,} bytes)',flush=True)


def source_projection():
    # HRRR Lambert conformal on spherical Earth; x/y coordinates come from the
    # same cfgrib grid that supplied the native fields. Standard HRRR GRIB grid.
    from pyproj import CRS,Transformer
    crs=CRS.from_proj4('+proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +a=6371229 +b=6371229 +units=m +no_defs')
    return Transformer.from_crs('EPSG:4326',crs,always_xy=True)


def tile_xy_grid(z,tx,ty):
    px=np.arange(256,dtype=np.float64)+.5
    gx=tx+px/256;gy=ty+px/256
    lon=(gx/(2**z))*360.-180.
    lat=np.degrees(np.arctan(np.sinh(np.pi*(1.-2.*gy/(2**z)))))
    return np.meshgrid(lon,lat)


def bounds_to_tiles(z):
    def tx(lon):return int(math.floor((lon+180.)/360.*2**z))
    def ty(lat):return int(math.floor((1.-math.asinh(math.tan(math.radians(lat)))/math.pi)*.5*2**z))
    return range(max(0,tx(-130)),min(2**z-1,tx(-60))+1),range(max(0,ty(55)),min(2**z-1,ty(20))+1)


def upload_tiles(run,full,x,y,workers=12):
    from scipy.ndimage import map_coordinates
    from botocore.config import Config
    s3=s3client()
    transform=source_projection()
    dx=np.median(np.diff(x));dy=np.median(np.diff(y))
    if abs(dx)<1. or abs(dy)<1.:raise RuntimeError('Unexpected HRRR projected x/y spacing')
    def send(z,tx,ty):
        lon,lat=tile_xy_grid(z,tx,ty)
        xx,yy=transform.transform(lon,lat)
        col=(xx-x[0])/dx;row=(yy-y[0])/dy
        valid=(col>=0)&(col<GRID_COLS-1)&(row>=0)&(row<GRID_ROWS-1)
        sampled=map_coordinates(full,np.stack((np.clip(row,0,GRID_ROWS-1),np.clip(col,0,GRID_COLS-1))),order=1,mode='nearest',prefilter=False)
        # Avoid NaN propagation near coastal/terrain gaps: nearest for points
        # where the 4 source points are invalid.
        bad=~np.isfinite(sampled)
        if np.any(bad & valid):
            fallback=map_coordinates(full,np.stack((np.clip(row,0,GRID_ROWS-1),np.clip(col,0,GRID_COLS-1))),order=0,mode='nearest')
            sampled=np.where(bad,fallback,sampled)
        valid&=np.isfinite(sampled)
        encoded=np.full((256,256),NO_DATA,dtype='<u2')
        # 1 J/kg per uint16 count, 65535 reserved as nodata.
        encoded[valid]=np.minimum(65000.,np.maximum(0.,np.rint(sampled[valid]))).astype(np.uint16)
        # Do not store completely empty ocean/exterior tiles.
        if not np.any(valid):return None
        key=s3key(run,f'ecape/z{z}/{tx}/{ty}.bin')
        s3.put_object(Bucket=BUCKET,Key=key,Body=encoded.tobytes(order='C'),ContentType='application/octet-stream',CacheControl='public,max-age=31536000,immutable')
        return key
    import boto3
    allpos=[(z,tx,ty) for z in ZOOMS for txs,tys in [bounds_to_tiles(z)] for ty in tys for tx in txs]
    print(f'Uploading up to {len(allpos):,} tile positions, {len(ZOOMS)} zoom levels',flush=True)
    count=0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures=[pool.submit(send,*p) for p in allpos]
        for f in as_completed(futures):
            if f.result() is not None: count+=1
    if count<100:raise RuntimeError(f'Unexpected tile count {count}; not publishing ECAPE metadata')
    return count


def publish(run,shards,force=False):
    PART_DIR.mkdir(parents=True,exist_ok=True)
    parts=sorted(PART_DIR.glob('ecape_shard_*.npz'))
    if len(parts)!=shards:raise RuntimeError(f'Expected {shards} shards; found {len(parts)} in {PART_DIR}')
    full=np.full((GRID_ROWS,GRID_COLS),np.nan,dtype=np.float32)
    covered=np.zeros(GRID_ROWS,dtype=np.bool_)
    all_x=None;full_y=np.full(GRID_ROWS,np.nan)
    for path in parts:
        with np.load(path) as d:
            if str(d['run'].item())!=run:raise RuntimeError(f'Wrong run in {path.name}')
            start=int(d['start']);stop=int(d['stop'])
            if np.any(covered[start:stop]):raise RuntimeError(f'Duplicate rows from {path.name}')
            if d['ecape'].shape!=(stop-start,GRID_COLS):raise RuntimeError('Shard dimensions differ')
            full[start:stop]=d['ecape'];covered[start:stop]=True
            full_y[start:stop]=d['y']
            if all_x is None:all_x=d['x'].copy()
            elif not np.allclose(all_x,d['x']):raise RuntimeError('Inconsistent HRRR x axes')
    if not np.all(covered):raise RuntimeError('Some native HRRR rows were not computed')
    if not np.all(np.isfinite(full_y)) or not np.all(np.diff(full_y)>0):raise RuntimeError('HRRR y grid invalid')
    valid=full[np.isfinite(full)]
    if valid.size<0.5*full.size:raise RuntimeError('ECAPE quality check failed')
    print(f'Complete HRRR {GRID_ROWS}x{GRID_COLS}: {valid.size:,} finite points, min={np.min(valid):.1f}, max={np.max(valid):.1f}',flush=True)
    s3=s3client()
    # Publishing product-specific metadata LAST; main pointer remains untouched.
    count=upload_tiles(run,full,all_x,full_y,int(os.getenv('SPCOA_ECAPE_UPLOAD_WORKERS','16')))
    metadata={
        'key':'ecape','name':'Surface-Based ECAPE (HRRR F00)','short_name':'SBECAPE',
        'run':run,'analysis_time':datetime.strptime(run,'%Y%m%d_%H').strftime('%Y-%m-%dT%H:00:00Z'),
        'units':'J/kg','source_units':'J/kg','type':'scalar',
        'encoding':{'dtype':'uint16','endianness':'little','nodata':65535,'scale':1.0,'offset':0.0,'formula':'physical_value = encoded_value * scale + offset'},
        'display':{'type':'filled','color_scheme':'ecape','minimum':0.,'maximum':10500.,'opacity':1.},
        'tile_size':256,'zoom_levels':list(ZOOMS),'tile_projection':'EPSG:3857','tile_scheme':'XYZ',
        'native_grid_shape':[GRID_ROWS,GRID_COLS],'native_horizontal_stride':1,
        'vertical_profile_spacing_m':DZ,'vertical_profile_top_m':TOP,'source_model':'HRRR','forecast_hour':0,
        'algorithm':'Peters-style analytic ECAPE, compiled adaptation of supplied CAM viewer code',
        'original_reference_validation_required':True,
        'statistics':{'minimum':float(np.min(valid)),'maximum':float(np.max(valid)),'mean':float(np.mean(valid)),'valid_native_points':int(len(valid))},
        'tiles_uploaded':count,
    }
    s3.put_object(Bucket=BUCKET,Key=s3key(run,'ecape/metadata.json'),Body=json.dumps(metadata,indent=2).encode(),ContentType='application/json',CacheControl='public,max-age=300')
    print(f'Success: s3://{BUCKET}/{s3key(run,"ecape/metadata.json")}; main SPCOA pointers unchanged',flush=True)


def selftest():
    # Synthetic stable and convectively unstable soundings for execution-path
    # verification only; meteorological match to CAM implementation unverified.
    nz=NVERT;z=np.arange(nz)*DZ
    T=(302.-.0062*z).astype('f8');T=np.maximum(T,185.)
    p=100000.*np.exp(-z/8200.)
    q=.017*np.exp(-z/2300.)
    u=5.+.003*z;v=1.+.001*z
    b=np.empty(nz);m=np.empty(nz)
    val=profile_ecape(T,p,q,u,v,z,b,m)
    print(f'Synthetic ECAPE={val}, finite? {math.isfinite(val)}')
    surf=np.zeros((6,3),dtype='f4');prs=np.zeros((5,29,3),dtype='f4')
    surf[0]=302;surf[1]=.017;surf[2]=100000;surf[3]=300;surf[4]=5;surf[5]=1
    plev=np.linspace(990.,75.,29)
    for k,pres in enumerate(plev):
        h=-8200.*np.log(pres*100./100000.)
        prs[0,k,:]=300+h;prs[1,k,:]=max(185.,302-.0062*h)
        prs[2,k,:]=.017*np.exp(-h/2300);prs[3,k,:]=5+.003*h;prs[4,k,:]=1+.001*h
    res=compute_strip(surf,prs,plev)
    assert res.shape==(3,)
    assert np.all(np.isfinite(res)),res
    print('PASS: Numba scalar and parallel native-grid ECAPE kernel compiles and executes:',res)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=('resolve','compute','publish','selftest'))
    parser.add_argument('--run',default=os.getenv('SPCOA_ECAPE_RUN',''))
    parser.add_argument('--shard',type=int,default=0)
    parser.add_argument('--shards',type=int,default=12)
    parser.add_argument('--force',action='store_true')
    args=parser.parse_args()
    if args.mode=='selftest':selftest();return
    if args.mode=='resolve':resolve_run(args.run,args.force);return
    if not args.run:raise SystemExit('--run is required')
    if args.mode=='compute':compute(args.run,args.shard,args.shards)
    if args.mode=='publish':publish(args.run,args.shards,args.force)

if __name__=='__main__':main()
