#!/usr/bin/env python3
"""Diagnose SPCOA vs Pivotal 100-hPa mixed-layer CAPE/CIN on SAME HRRR cycle.

Read-only. Uses the existing SPCOA archive; neither updates S3 nor changes
spcoa_sounding_diagnostics.py. Outputs gridpoint coordinate, low-level profile,
SHARPpy's default versus explicit 100-hPa ML parcel, layer-integrated theta/q,
and controlled sensitivities to mixing depth and the appended 2m surface row.

Caution: Pivotal can interpolate to its requested coordinate. This tool can
match its *requested* lat/lon, not prove an identical provider data sampling.
"""
# V4 adds 3x3 native-grid-neighbor sampling to quantify whether spatial
# HRRR variance could explain Pivotal screenshot mismatch.
# Earlier comparison adds an independent pressure-weighted 100-hPa parcel to
# distinguish SHARPpy's exact=True native-level averaging (unweighted by dp)
# from pressure-thickness-weighted theta/mixing ratio. It DOES NOT modify S3.
from __future__ import annotations

import argparse
import copy
import csv
import json
import math
from pathlib import Path

import numpy as np

import spcoa_sounding_diagnostics as sd

PIVOTAL_SCREENSHOT = {
    'model': 'HRRR', 'run_id': '20261028_06',
    'requested_lat': 41.18, 'requested_lon': -100.59,
    'ML': {'cape_jkg': 160., 'cin_jkg': -167., 'lcl_m_agl': 477.,
           'lfc_m_agl': 3890., 'el_m_agl': 8825.},
    'MU': {'cape_jkg': 664., 'cin_jkg': -25., 'lcl_m_agl': 602.,
           'lfc_m_agl': 2537., 'el_m_agl': 9818.},
}


def clean_num(v, digits=3):
    try:
        if np.ma.is_masked(v):
            return None
        x = float(np.asarray(v).reshape(-1)[0])
        return round(x, digits) if math.isfinite(x) else None
    except (ValueError, TypeError, IndexError, OverflowError):
        return None


def stat_parcel(p):
    return {k: clean_num(getattr(p, attr, None), 2) for k, attr in (
        ('cape_jkg', 'bplus'), ('cin_jkg', 'bminus'),
        ('lcl_m_agl', 'lclhght'), ('lfc_m_agl', 'lfchght'),
        ('el_m_agl', 'elhght'), ('starting_pressure_hpa', 'pres'),
        ('starting_temp_c', 'tmpc'), ('starting_dewpoint_c', 'dwpc'),
    )}


def integrate_layer(p_desc, field, depth=100., step=.25):
    """Pressure-weighted independent integration, using linear-p interpolation.

    This is a check of parcel initialization, NOT a replacement for SHARPpy's
    exact (native-level) layer integration, which can use different quadrature.
    """
    p = np.asarray(p_desc, float)
    y = np.asarray(field, float)
    if p.ndim != 1 or y.shape != p.shape or len(p) < 2:
        raise ValueError('invalid pressure profile')
    if not np.all(np.diff(p) < 0):
        raise ValueError('pressure not descending')
    pbot, ptop = p[0], p[0] - depth
    if ptop < p[-1]:
        raise ValueError('insufficient upper data to integrate pressure layer')
    pres = np.linspace(ptop, pbot, max(2, int(math.ceil(depth/step))+1))
    val = np.interp(pres, p[::-1], y[::-1])
    return float(np.trapz(val, pres) / (pbot-ptop))


def profile_snapshot(raw, qc_pr, td, zmin_hpa=155):
    from metpy.calc import potential_temperature
    from metpy.units import units

    p = np.asarray(qc_pr['pressure_hpa'], float)
    t = np.asarray(qc_pr['temperature_k'], float)
    q = np.asarray(qc_pr['specific_humidity_kgkg'], float)
    z = np.asarray(qc_pr['height_m_msl'], float)
    theta = np.asarray(potential_temperature(p * units.hPa, t * units.kelvin)
                       .to('kelvin').magnitude, float)
    raw_p = np.asarray(raw['pressure_hpa'], float)
    raw_t = np.asarray(raw['temperature_k'], float)
    n_native_below_surface = int(np.count_nonzero(np.isfinite(raw_p[1:]) & (raw_p[1:] >= p[0])))
    first_native_idx = next((k for k in range(1,len(raw_p)) if
                             np.isfinite(raw_p[k]) and raw_p[k] < p[0]), None)
    rows=[]
    for k in range(len(p)):
        if p[k] < p[0] - zmin_hpa:
            break
        rows.append({
            'pressure_hpa':clean_num(p[k],2),
            'height_agl_m':clean_num(z[k]-z[0],1),
            'temp_c':clean_num(t[k]-273.15,3),
            'dewpoint_c':clean_num(td[k],3),
            'theta_k':clean_num(theta[k],3),
            'specific_humidity_gkg':clean_num(q[k]*1000,4),
            'mixing_ratio_gkg':clean_num(q[k]/(1-q[k])*1000,4),
        })
    means={
        'pressure_layer_hpa': [clean_num(p[0],2),clean_num(p[0]-100,2)],
        'theta_k_independent_pressure_integral':clean_num(integrate_layer(p,theta,100),4),
        'mixing_ratio_gkg_independent_pressure_integral':clean_num(
            integrate_layer(p,q/(1-q)*1000,100),4),
        'native_levels_in_100_hpa':int(np.count_nonzero((p[1:] >= p[0]-100) & (p[1:] < p[0]))),
        'levels_discarded_by_existing_preparation':int(qc_pr['levels_native']-qc_pr['levels_valid']),
        'native_levels_with_pressure_at_or_above_surface':n_native_below_surface,
        'first_raw_native_pressure_hpa':clean_num(raw_p[first_native_idx],2) if first_native_idx is not None else None,
        'first_raw_native_temp_c':clean_num(raw_t[first_native_idx]-273.15,3) if first_native_idx is not None else None,
    }
    return rows,means



def pressure_weighted_ml_parcel(sprof, depth_hpa=100, step_hpa=0.25):
    """Reference comparison: pressure-mass-weighted (theta, r) in lowest 100 hPa.

    Calculates the layer mean by numerical integration of SHARPpy-derived
    potential temperature (C referenced to 1000 hPa) and mixing ratio (g/kg).
    Uses *exactly the existing, QC'd HRRR profile* and a user-defined parcel
    to isolate the averaging method. The parcel is still lifted by SHARPpy
    with the same virtual-temperature correction as the standard ML parcel.

    This is diagnostic ONLY. It does not change the established SPCOA backend,
    and it is not evidence of the exact Pivotal Weather implementation.
    """
    from sharppy.sharptab import params, thermo
    p = np.ma.filled(sprof.pres, np.nan).astype(float)
    t = np.ma.filled(sprof.tmpc, np.nan).astype(float)
    td = np.ma.filled(sprof.dwpc, np.nan).astype(float)
    valid = np.isfinite(p) & np.isfinite(t) & np.isfinite(td)
    p,t,td=p[valid],t[valid],td[valid]
    if len(p)<3 or not np.all(np.diff(p)<0):
        raise ValueError('SHARPpy input pressure must be descending')
    pbot=float(p[0]);ptop=pbot-float(depth_hpa)
    if ptop<float(p[-1]):
        raise ValueError('Native sounding does not cover full ML pressure layer')
    # 0.25-hPa integration grid: each pressure thickness receives equal weight,
    # unlike treating all native model levels as equally representative.
    pi=np.linspace(ptop,pbot,int(np.ceil(depth_hpa/step_hpa))+1)
    theta=np.asarray(thermo.theta(p,t),float)  # C referenced to 1000 hPa
    mix=np.asarray(thermo.mixratio(p,td),float) # g/kg
    theta_mean=float(np.trapz(np.interp(pi,p[::-1],theta[::-1]),pi)/depth_hpa)
    mix_mean=float(np.trapz(np.interp(pi,p[::-1],mix[::-1]),pi)/depth_hpa)
    if not np.isfinite(theta_mean) or not np.isfinite(mix_mean) or mix_mean<=0:
        raise ValueError('Invalid independent layer means')
    tstart=float(thermo.theta(1000.,theta_mean,pbot))
    tdstart=float(thermo.temp_at_mixrat(mix_mean,pbot))
    if tdstart>tstart+0.25:
        raise ValueError('Pressure-weighted parcel shows large supersaturation')
    if tdstart>tstart:
        tdstart=tstart
    lpl=params.DefineParcel(sprof,flag=5,pres=pbot,tmpc=tstart,dwpc=tdstart)
    pcl=params.parcelx(sprof,lplvals=lpl)
    return {
        'method': 'pressure-integrated theta and mixing ratio, 0.25-hPa grid; 100-hPa depth',
        'mean_theta_k':clean_num(theta_mean+273.15,4),
        'mean_mixing_ratio_gkg':clean_num(mix_mean,4),
        'parcel_origin':{'pressure_hpa':clean_num(pbot,3),'temp_c':clean_num(tstart,4),
                         'dewpoint_c':clean_num(tdstart,4)},
        'diagnostics':stat_parcel(pcl),
    }

def sharppy_interpolated_ml_parcel(sprof, depth_hpa=100):
    """Diagnostic control: SHARPpy 1-hPa interpolated means (exact=False).

    This is not Pivotal's proven method. It isolates whether the native-level
    exact=True mean versus interpolated SHARPpy mean changes the parcel result.
    """
    from sharppy.sharptab import params, thermo
    pbot=float(sprof.pres[sprof.sfc]); ptop=pbot-depth_hpa
    mt=params.mean_theta(sprof,pbot=pbot,ptop=ptop,exact=False)
    mr=params.mean_mixratio(sprof,pbot=pbot,ptop=ptop,exact=False)
    t=float(thermo.theta(1000.,mt,pbot))
    td=float(thermo.temp_at_mixrat(mr,pbot))
    if not np.isfinite([t,td]).all() or td>t+.25:
        raise ValueError('Invalid interpolated ML parcel')
    td=min(td,t)
    lpl=params.DefineParcel(sprof,flag=5,pres=pbot,tmpc=t,dwpc=td)
    return {'method':'SHARPpy 1-hPa interpolated means (exact=False)',
            'parcel_origin':{'pressure_hpa':clean_num(pbot,3),
                             'temp_c':clean_num(t,4),'dewpoint_c':clean_num(td,4)},
            'diagnostics':stat_parcel(params.parcelx(sprof,lplvals=lpl))}


def analyze(raw, include_sensitivities=True):
    from metpy.calc import dewpoint_from_specific_humidity
    from metpy.units import units
    from sharppy.sharptab import params

    pr=sd.prepare_profile(raw)
    td_unadjusted=sd.make_dewpoint(pr)
    td,qc,warnings=sd.qc_moisture_profile(pr,td_unadjusted)
    shp=sd.build_sharppy_profile(pr,td)
    out={
      'selected_native_point':{
        'lat':clean_num(pr.get('lat'),6),'lon':clean_num(pr.get('lon'),6),
        'j':pr.get('j'),'i':pr.get('i'),'surface_pressure_hpa':clean_num(pr['pressure_hpa'][0],2),
        'surface_temperature_c':clean_num(pr['temperature_k'][0]-273.15,3),
        'surface_dewpoint_c':clean_num(td[0],3),
        'levels_valid':pr['levels_valid'],'levels_native':pr['levels_native'],
      },
      'moisture_qc':qc,'warnings':warnings,
    }
    rows,means=profile_snapshot(raw,pr,td)
    out['low_level_pressure_table']=rows
    out['lowest_100_hpa_layer_check']=means
    ml_def=params.DefineParcel(shp,flag=4,pres=100)
    out['SHARPpy_ML_100hpa_explicit'] = stat_parcel(sd.sharppy_lift_parcel(shp,4,100))
    out['SHARPpy_ML_100hpa_default'] = stat_parcel(params.parcelx(shp,flag=4))
    out['SHARPpy_ML_origin']={
       'pres_hpa':clean_num(ml_def.pres,3),
       'temp_c':clean_num(ml_def.tmpc,4),
       'dewpoint_c':clean_num(ml_def.dwpc,4),
       'SHARPpy_pressure_mean_theta_c_at_1000hpa':clean_num(
          params.mean_theta(shp,pbot=float(shp.pres[shp.sfc]),
                            ptop=float(shp.pres[shp.sfc])-100,exact=True),4),
       'SHARPpy_pressure_mean_mixing_ratio_gkg':clean_num(
          params.mean_mixratio(shp,pbot=float(shp.pres[shp.sfc]),
                               ptop=float(shp.pres[shp.sfc])-100,exact=True),4),
    }
    out['ML_100hpa_pressure_weighted_reference'] = pressure_weighted_ml_parcel(shp)
    out['ML_100hpa_SHARPpy_interpolated_mean_reference'] = sharppy_interpolated_ml_parcel(shp)
    # Difference isolates native-level averaging versus pressure-weighted mean:
    # both lifts use the same SHARPpy parcelx on the same QC'd HRRR profile.
    std=out['SHARPpy_ML_100hpa_explicit']
    refp=out['ML_100hpa_pressure_weighted_reference']['diagnostics']
    out['ML_pressure_mean_minus_standard'] = {
        k: clean_num(refp[k]-std[k],3) if refp.get(k) is not None and std.get(k) is not None else None
        for k in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl')
    }

    out['SHARPpy_MU_300hpa'] = stat_parcel(sd.sharppy_lift_parcel(shp,3,300))
    mlA=out['SHARPpy_ML_100hpa_explicit'];mlB=out['SHARPpy_ML_100hpa_default']
    out['SHARPpy_default_vs_explicit_agree'] = all(
        (mlA[k] is None and mlB[k] is None) or
        (mlA[k] is not None and mlB[k] is not None and abs(mlA[k]-mlB[k]) < 1.)
        for k in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl'))
    if not out['SHARPpy_default_vs_explicit_agree']:
        out['warnings'].append('SHARPpy default flag=4 differs from explicit DefineParcel+parcelx; inspect version/API!')

    if include_sensitivities:
        out['sensitivity_only_not_reference_definition']={}
        for depth in (50,75,125,150):
            try:
                out['sensitivity_only_not_reference_definition'][f'ML_{depth}hpa']=stat_parcel(
                    sd.sharppy_lift_parcel(shp,4,depth))
            except Exception as exc:
                out['sensitivity_only_not_reference_definition'][f'ML_{depth}hpa']={'error':str(exc)}
        # The first archive entry is synthetic near-surface: sfc P + 2m T/q + 10m winds.
        # Dropping it makes a different physical sounding; this is a sensitivity,
        # NOT a corrected version of the original, and cannot prove Pivotal equivalence.
        try:
            native_only = {k: (np.asarray(v)[1:].tolist() if k in sd.FIELDS else v)
                           for k,v in raw.items()}
            pr2=sd.prepare_profile(native_only)
            td2=sd.make_dewpoint(pr2)
            td2,_,_=sd.qc_moisture_profile(pr2,td2)
            shp2=sd.build_sharppy_profile(pr2,td2)
            out['sensitivity_only_not_reference_definition']['native_hybrid_without_appended_2m_row']={
              'surface_pressure_hpa':clean_num(pr2['pressure_hpa'][0],2),
              'surface_temperature_c':clean_num(pr2['temperature_k'][0]-273.15,3),
              'ML':stat_parcel(sd.sharppy_lift_parcel(shp2,4,100)),
              'ML_pressure_weighted':pressure_weighted_ml_parcel(shp2),
              'ML_SHARPpy_interpolated':sharppy_interpolated_ml_parcel(shp2),
              'MU':stat_parcel(sd.sharppy_lift_parcel(shp2,3,300)),
            }
        except Exception as exc:
            out['sensitivity_only_not_reference_definition']['native_hybrid_without_appended_2m_row']={
              'error':f'{type(exc).__name__}: {exc}'}
    return out



def neighbor_spatial_audit(client, run, manifest, central, radius: int = 1):
    """Evaluate same 100-hPa ML definitions across a small native grid stencil.

    Spatial sensitivity only; not proof of how Pivotal horizontally interpolates
    HRRR to a particular lat/lon. No changes to uploaded sounding fields.
    """
    from sharppy.sharptab import params
    j0 = int(central['j']); i0 = int(central['i'])
    rows=[]
    for dj in range(-radius,radius+1):
        for di in range(-radius,radius+1):
            jj,ii=j0+dj,i0+di
            if not (0<=jj<1059 and 0<=ii<1799): continue
            row={'j':jj,'i':ii,'dj':dj,'di':di}
            try:
                raw=sd.profile_at_index(client,run,manifest,jj,ii)
                pr=sd.prepare_profile(raw)
                td=sd.make_dewpoint(pr)
                td,qc,_=sd.qc_moisture_profile(pr,td)
                shp=sd.build_sharppy_profile(pr,td)
                row.update(lat=clean_num(pr['lat'],6),lon=clean_num(pr['lon'],6),
                           surface_temp_c=clean_num(pr['temperature_k'][0]-273.15,3),
                           surface_td_c=clean_num(td[0],3),
                           native_levels_100hpa=int(np.count_nonzero((pr['pressure_hpa'][1:] >= pr['pressure_hpa'][0]-100)&(pr['pressure_hpa'][1:] < pr['pressure_hpa'][0]))),
                           qc_levels_capped=qc.get('source_levels_with_td_above_t'))
                ml_def=stat_parcel(sd.sharppy_lift_parcel(shp,4,100))
                ml_inter=sharppy_interpolated_ml_parcel(shp)['diagnostics']
                for pref,record in (('native_mean',ml_def),('interp_mean',ml_inter)):
                    for k in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl'):
                        row[f'{pref}_{k}']=record.get(k)
            except Exception as exc:
                row['error']=f'{type(exc).__name__}: {exc}'
            rows.append(row)
    return rows


def neighbor_summary(rows, screenshot=None):
    """Numerical ranges are observations of model-grid variability, not equivalence."""
    out={'count_requested':len(rows),'count_succeeded':sum('error' not in r for r in rows),
         'caveat':'Native grid stencil is not a reconstruction of Pivotal horizontal interpolation or parcel methodology.'}
    for pref in ('native_mean','interp_mean'):
        out[pref]={}
        for metric in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl'):
            key=f'{pref}_{metric}'
            vals=[float(row[key]) for row in rows if row.get(key) is not None and np.isfinite(row[key])]
            out[pref][metric]={
                'minimum':clean_num(min(vals)) if vals else None,
                'maximum':clean_num(max(vals)) if vals else None,
                'count':len(vals),
            }
            if screenshot and metric in screenshot:
                target=screenshot[metric]
                out[pref][metric]['pivotal_reference']=target
                out[pref][metric]['pivotal_within_grid_range']=(min(vals)<=target<=max(vals)) if vals else None
    return out


def approx_km(lat1,lon1,lat2,lon2):
    # Good for close points, just to report separation, not selecting gridpoints.
    phi1, phi2=math.radians(lat1),math.radians(lat2)
    a=math.sin((phi2-phi1)/2)**2+math.cos(phi1)*math.cos(phi2)*math.sin(math.radians(lon2-lon1)/2)**2
    return round(6371.0088*2*math.atan2(math.sqrt(a),math.sqrt(max(0,1-a))),3)


def fmt(x): return '—' if x is None else str(x)


def summary_text(report):
    lines=['SPCOA vs Pivotal: HRRR F00 MIXED-LAYER AUDIT V4',
           f"Run: {report['run_id']}",
           'Pivotal values were transcribed from the user-provided screenshot; no Pivotal raw profile was available.',
           'The nearest SPCOA native grid point is not necessarily identical to Pivotal interpolation.', '']
    for name,a in report['points'].items():
        pt=a['selected_native_point']; l=a['SHARPpy_ML_origin']; x=a['SHARPpy_ML_100hpa_explicit']
        lines.extend([
          f"[{name}] ({pt['lat']}, {pt['lon']}) grid j={pt['j']} i={pt['i']} pSfc={pt['surface_pressure_hpa']} hPa",
          f"  SFC T/Td = {pt['surface_temperature_c']}/{pt['surface_dewpoint_c']} C; levels valid {pt['levels_valid']}",
          f"  ML start p/T/Td = {l['pres_hpa']}/{l['temp_c']}/{l['dewpoint_c']}",
          f"  STANDARD ML CAPE/CIN/LCL/LFC/EL = {' / '.join(fmt(x[k]) for k in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl'))}",
          f"  PRESSURE-WEIGHTED ML CAPE/CIN/LCL/LFC/EL = {' / '.join(fmt(a['ML_100hpa_pressure_weighted_reference']['diagnostics'][k]) for k in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl'))}",
          f"  Pressure-weighted ML origin = {a['ML_100hpa_pressure_weighted_reference']['parcel_origin']}",
          f"  SHARPpy interpolated-mean ML CAPE/CIN/LCL/LFC/EL = {' / '.join(fmt(a['ML_100hpa_SHARPpy_interpolated_mean_reference']['diagnostics'][k]) for k in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl'))}",
          f"  MU CAPE/CIN/LCL = {' / '.join(fmt(a['SHARPpy_MU_300hpa'][k]) for k in ('cape_jkg','cin_jkg','lcl_m_agl'))}",
          f"  SHARPpy explicit and direct default same? {a['SHARPpy_default_vs_explicit_agree']}",
          f"  Lower 100 hPa native levels: {a['lowest_100_hpa_layer_check']['native_levels_in_100_hpa']}",
          f"  Mean layer theta K (independent): {a['lowest_100_hpa_layer_check']['theta_k_independent_pressure_integral']}",
          f"  Mean layer mixing ratio g/kg (independent): {a['lowest_100_hpa_layer_check']['mixing_ratio_gkg_independent_pressure_integral']}",
        ])
        # Controlled 2x3 design: same grid cell and same SHARPpy parcelx,
        # vary only input surface row and ML-layer averaging algorithm.
        native = a.get('sensitivity_only_not_reference_definition',{}).get('native_hybrid_without_appended_2m_row',{})
        if 'error' in native:
            lines.append(f"  Native-only sensitivity unavailable: {native['error']}")
        elif native:
            lines.append('  CONTROLLED ML COMPARISON (CAPE / CIN / LCL):')
            variants = [
              ('2m appended, native-level exact=True', a['SHARPpy_ML_100hpa_explicit']),
              ('2m appended, pressure-integrated mean', a['ML_100hpa_pressure_weighted_reference']['diagnostics']),
              ('2m appended, SHARPpy interpolated mean', a['ML_100hpa_SHARPpy_interpolated_mean_reference']['diagnostics']),
              ('native only, native-level exact=True', native['ML']),
              ('native only, pressure-integrated mean', native['ML_pressure_weighted']['diagnostics']),
              ('native only, SHARPpy interpolated mean', native['ML_SHARPpy_interpolated']['diagnostics']),
            ]
            for label, rec in variants:
                lines.append(f"    {label}: {fmt(rec.get('cape_jkg'))} / {fmt(rec.get('cin_jkg'))} / {fmt(rec.get('lcl_m_agl'))}")
        for w in a['warnings']:lines.append(f'  WARNING: {w}')
        lines.append('')
    if 'pivotal_requested_gridpoint' in report['points'] and report.get('pivotal_reference'):
        got=report['points']['pivotal_requested_gridpoint']
        ref=report['pivotal_reference']
        lines.append('Pivotal screenshot reference vs SPCOA nearest native gridpoint to requested coordinate:')
        for name in ('ML','MU'):
            calc=got['SHARPpy_ML_100hpa_explicit' if name=='ML' else 'SHARPpy_MU_300hpa']
            lines.append(f'  {name}:')
            for key in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl'):
                vv=calc.get(key); refv=ref[name].get(key)
                delta=round(vv-refv,2) if vv is not None and refv is not None else None
                lines.append(f'    {key}: Pivotal={fmt(refv)} SPCOA={fmt(vv)} difference={fmt(delta)}')
        lines.append('  ML: pressure-weighted parcel (same QC HRRR profile and SHARPpy parcelx):')
        calc=got['ML_100hpa_pressure_weighted_reference']['diagnostics']
        for key in ('cape_jkg','cin_jkg','lcl_m_agl','lfc_m_agl','el_m_agl'):
            vv=calc.get(key);refv=ref['ML'].get(key)
            delta=round(vv-refv,2) if vv is not None and refv is not None else None
            lines.append(f'    {key}: Pivotal={fmt(refv)} weighted={fmt(vv)} difference={fmt(delta)}')
    if report.get('neighbor_grid_summary'):
        sm=report['neighbor_grid_summary']
        lines.extend(['', 'NATIVE GRID 3x3 SPATIAL SENSITIVITY (Pivotal requested point)',
                      f"  Profiles computed: {sm['count_succeeded']}/{sm['count_requested']}"])
        for typ,name in (('native_mean','SHARPpy native-level mean'),
                         ('interp_mean','SHARPpy interpolated 1-hPa mean')):
            summary=sm.get(typ,{})
            for k in ('cape_jkg','cin_jkg','lcl_m_agl'):
                info=summary.get(k,{})
                lines.append(f"  {name}: {k} range={fmt(info.get('minimum'))} to {fmt(info.get('maximum'))}; Pivotal={fmt(info.get('pivotal_reference'))}; within_range={fmt(info.get('pivotal_within_grid_range'))}")
        lines.append('  Grid range can bracket a Pivotal number without proving equivalent parcel or spatial sampling.')
    elif report.get('neighbor_grid_note'):
        lines.extend(['', 'NEIGHBOR SPATIAL TEST: '+report['neighbor_grid_note']])
    lines.extend(['', 'DIAGNOSIS RULES:',
      '  A. If the default SHARPpy and explicit ML computations differ, the parcel call requires repair.',
      '  B. If both agree but the low-level layer/profile differs, inspect native vertical data, 2-m surface merge, QC and interpolation.',
      '  C. If the two nearby SPCOA gridpoints differ substantially, location sampling may explain some of the discrepancy.',
      '  D. If the ML mixing-depth sensitivities dominate, inspect parcel-definition choices; do NOT silently change the canonical 100-hPa depth.',
      '  E. A complete same-profile confirmation requires the actual Pivotal input profile or independently extracted HRRR grib at the same native cell.',
      '  F. Zero CAPE and zero CIN from SHARPpy do not independently establish an absence of negative buoyancy.',
      '  G. A close match to Pivotal is diagnostic evidence, not proof: the underlying Pivotal raw profile and algorithms remain unavailable.',
      '  H. A near-match in LCL alone can be coincidental. Compare CAPE, CIN, LFC, EL and independent low-level T/Td as well.',
      '  I. The 2m-appended and native-only profiles are deliberately different inputs; never silently substitute either in operational outputs.',
      '  J. Only exact equivalent source profiles and parcel definitions can prove algorithm-level agreement with Pivotal.',
    ])
    return '\n'.join(lines)+'\n'


def main():
    ap=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--run',default='20261028_06',help='Completed HRRR F00 SPCOA archive, YYYYMMDD_HH')
    ap.add_argument('--pivotal-lat',type=float,default=41.18)
    ap.add_argument('--pivotal-lon',type=float,default=-100.59)
    ap.add_argument('--spcoa-lat',type=float,default=41.18)
    ap.add_argument('--spcoa-lon',type=float,default=-100.69)
    ap.add_argument('--out-dir',default='ml_pivotal_audit')
    ap.add_argument('--neighbor-radius',type=int,default=1,help='Native-grid spatial sensitivity radius (0,1,2); 1 gives a 3x3 grid')
    ap.add_argument('--skip-neighbors',action='store_true',help='Skip native-grid spatial sensitivity test')
    ap.add_argument('--profile-pivotal-json',default='',help='Optional raw archive-format profile JSON for offline test')
    ap.add_argument('--profile-spcoa-json',default='',help='Optional raw archive-format profile JSON for offline test')
    args=ap.parse_args()
    sd.run_valid(args.run)
    if args.neighbor_radius not in (0,1,2):
        ap.error('--neighbor-radius must be 0, 1, or 2 (max 5x5 points)')
    outdir=Path(args.out_dir);outdir.mkdir(parents=True,exist_ok=True)
    report={'schema':'spcoa.ml_parcel_audit.v4','run_id':args.run,
            'methods':{'ML':'2x3 factorial test of 2m-surface merge versus native-only, and SHARPpy native-level exact=True vs independent pressure-weighted vs SHARPpy 1-hPa interpolated means. All parcels lifted by same SHARPpy parcelx',
                       'low_level_data':'SPCOA native hybrid plus 2m pseudo surface; capped supersaturation <=0.25 C',
                       'spatial_sensitivity':'Nearest native grid stencil to Pivotal requested coordinate; same QC HRRR profiles lifted using SHARPpy native-level and 1-hPa interpolated ML parcels'},
            'requested_coordinates':{'pivotal':[args.pivotal_lat,args.pivotal_lon],
                                     'spcoa':[args.spcoa_lat,args.spcoa_lon]},
            'pivotal_reference': PIVOTAL_SCREENSHOT if args.run=='20261028_06' and
                    abs(args.pivotal_lat-41.18)<.001 and abs(args.pivotal_lon+100.59)<.001 else None,
            'points':{}}
    client=None;manifest=None
    for name,lat,lon,local_path in [
        ('pivotal_requested_gridpoint',args.pivotal_lat,args.pivotal_lon,args.profile_pivotal_json),
        ('spcoa_prior_gridpoint',args.spcoa_lat,args.spcoa_lon,args.profile_spcoa_json),
    ]:
        if local_path:
            raw=json.loads(Path(local_path).read_text(encoding='utf-8'))
        else:
            if client is None:
                client=sd.s3();manifest=sd.get_manifest(client,args.run)
            raw=sd.closest_native_point(client,args.run,manifest,lat,lon)
        x=analyze(copy.deepcopy(raw))
        report['points'][name]=x
        with (outdir/f'{name}_low_level_profile.csv').open('w',newline='',encoding='utf-8') as f:
            csvout=csv.DictWriter(f,fieldnames=list(x['low_level_pressure_table'][0].keys()))
            csvout.writeheader();csvout.writerows(x['low_level_pressure_table'])
        print(f"{name}: actual grid ({x['selected_native_point']['lat']}, {x['selected_native_point']['lon']}); "
              f"ML CAPE {x['SHARPpy_ML_100hpa_explicit']['cape_jkg']}, "
              f"CIN {x['SHARPpy_ML_100hpa_explicit']['cin_jkg']}",flush=True)
    a,b=(report['points'][n]['selected_native_point'] for n in ('pivotal_requested_gridpoint','spcoa_prior_gridpoint'))
    if None not in (a['lat'],a['lon'],b['lat'],b['lon']):
        report['separation_of_selected_native_gridpoints_km']=approx_km(a['lat'],a['lon'],b['lat'],b['lon'])
    if args.skip_neighbors:
        report['neighbor_grid_note']='Skipped by --skip-neighbors.'
    elif args.profile_pivotal_json:
        report['neighbor_grid_note']='Skipped because an offline JSON profile was supplied, not an S3 native grid.'
    else:
        if client is None:
            client=sd.s3();manifest=sd.get_manifest(client,args.run)
        ppoint=report['points']['pivotal_requested_gridpoint']['selected_native_point']
        try:
            rows=neighbor_spatial_audit(client,args.run,manifest,ppoint,args.neighbor_radius)
            report['neighbor_grid_summary']=neighbor_summary(
                rows,report['pivotal_reference']['ML'] if report.get('pivotal_reference') else None)
            with (outdir/'ml_neighbor_grid.csv').open('w',newline='',encoding='utf-8') as f:
                keys=list(dict.fromkeys(key for row in rows for key in row))
                csvout=csv.DictWriter(f,fieldnames=keys)
                csvout.writeheader();csvout.writerows(rows)
            print(f"Neighbor grid: {report['neighbor_grid_summary']['count_succeeded']} successful points out of {len(rows)}",flush=True)
        except Exception as exc:
            report['neighbor_grid_note']=f"Neighbor-grid test failed: {type(exc).__name__}: {exc}"
            print(report['neighbor_grid_note'],flush=True)
    (outdir/'ml_pivotal_comparison.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    txt=summary_text(report)
    (outdir/'ML_AUDIT_SUMMARY.txt').write_text(txt,encoding='utf-8')
    print('\n'+txt)
    print('Files written to',outdir)


if __name__=='__main__':main()


if __name__=='__main__':main()
