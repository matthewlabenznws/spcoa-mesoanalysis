#!/usr/bin/env python3
"""SPCOA native HRRR F00 on-demand sounding diagnostics API (V7 / UI V63.1 identity diagnostic).

Deploy this as a Lambda container. The *same* handler accepts an API Gateway
HTTP GET (/diagnostics?run=YYYYMMDD_HH&j=...&i=...) and SQS worker records.

GET returns one of:
  200  exact grid point diagnostic JSON (cached S3 object)
  202  calculation queued; poll this URL again after retry_after_seconds
  400/404/405/500/503 descriptive error JSON

SQS events load authoritative archived native HRRR tiles from S3 and run the
V7 spcoa_sounding_diagnostics.diagnostics() function, then write
  spcoa/runs/YYYYMMDD_HH/soundings/v1/diagnostics/v7/j####/i####.json

The API NEVER accepts client-supplied meteorological profiles and NEVER writes
into the parent SPCOA analysis latest.json. The existing archive manifest
must be published before any point is queued.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import traceback
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

import spcoa_soundings as archive
import spcoa_sounding_diagnostics as met

QUEUE_URL = os.getenv('SPCOA_SOUNDING_QUEUE_URL', '')
RETRY_SECONDS = 7
API_HEADERS = {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}


def response(status: int, data: dict):
    return {'statusCode': status, 'headers': API_HEADERS,
            'body': json.dumps(met.json_safe(data), allow_nan=False)}


def s3():
    return archive.aws()


def _validate(run, j, i):
    if not re.fullmatch(r'\d{8}_(?:[01]\d|2[0-3])', str(run)):
        raise ValueError('run must be YYYYMMDD_HH (UTC)')
    date = datetime.strptime(run, '%Y%m%d_%H').replace(tzinfo=timezone.utc)
    if date > datetime.now(timezone.utc):
        raise ValueError('Future run is not permitted')
    try:
        j, i = int(j), int(i)
    except (ValueError, TypeError):
        raise ValueError('i and j must be integer native grid coordinates') from None
    if not (0 <= j < archive.ROWS and 0 <= i < archive.COLS):
        raise ValueError('i or j outside native HRRR grid')
    return run, j, i


def relative_diag(j, i):
    return f'diagnostics/v7/j{j:04d}/i{i:04d}.json'


def _is_missing(exc):
    if not isinstance(exc, ClientError):
        return False
    code = exc.response.get('Error', {}).get('Code', '')
    return code in ('404', 'NoSuchKey', 'NotFound') or exc.response.get('ResponseMetadata', {}).get('HTTPStatusCode') == 404


def _read_json(client, object_key):
    result = client.get_object(Bucket=archive.BUCKET, Key=object_key)
    return json.loads(result['Body'].read())


def _manifest(client, run):
    m = _read_json(client, archive.key(run, 'manifest.json'))
    if (m.get('complete') is not True or m.get('run_id') != run or
            m.get('schema') != archive.SCHEMA or
            m.get('grid_shape') != [archive.ROWS, archive.COLS]):
        raise ValueError('Sounding archive is not fully published for this run')
    return m


def cached_diagnostics(client, run, j, i):
    try:
        d = _read_json(client, archive.key(run, relative_diag(j, i)))
    except ClientError as exc:
        if _is_missing(exc):
            return None
        raise
    loc = d.get('location', {})
    if (d.get('schema') != 'spcoa.hrrr_f00_sounding_diagnostics.v2' or
            d.get('diagnostic_revision') != 7 or
            d.get('run_id') != run or
            loc.get('j') != j or loc.get('i') != i):
        # Wrong/legacy sidecar is not accepted as a match.
        return None
    return d


def _native_profile(client, run, j, i):
    j0, i0 = j // archive.BLOCK * archive.BLOCK, i // archive.BLOCK * archive.BLOCK
    key = archive.key(run, f'tiles/j{j0:04d}/i{i0:04d}.bin')
    packed = client.get_object(Bucket=archive.BUCKET, Key=key)['Body'].read()
    # S3 SDK returns the stored encoded bytes; browsers decode Content-Encoding.
    raw = gzip.decompress(packed) if packed.startswith(b'\x1f\x8b') else packed
    tile = archive.decode_tile(raw)
    if tile['j0'] != j0 or tile['i0'] != i0:
        raise ValueError('Wrong tile native grid coordinates')
    profile = archive.decode_profile(tile, j - j0, i - i0)
    if (profile['j'], profile['i']) != (j, i):
        raise ValueError('Decoded sounding gridpoint does not match request')
    profile['run_id'] = run
    return profile


def _calculate(run, j, i):
    client = s3()
    _manifest(client, run)
    if cached_diagnostics(client, run, j, i) is not None:
        print(f'CACHED {run} native j={j} i={i}', flush=True)
        return
    raw = _native_profile(client, run, j, i)
    result = met.json_safe(met.diagnostics(raw, ecape=True))
    # Strict identity guard: never cache a document for the wrong run, grid cell,
    # schema or diagnostic revision. Report the exact discrepancy in CloudWatch;
    # this catches mixed V62/V63 files in the same Lambda deployment.
    expected = {
        'schema': 'spcoa.hrrr_f00_sounding_diagnostics.v2',
        'diagnostic_revision': 7,
        'run_id': run,
        'location.j': j,
        'location.i': i,
    }
    loc = result.get('location') or {}
    observed = {
        'schema': result.get('schema'),
        'diagnostic_revision': result.get('diagnostic_revision'),
        'run_id': result.get('run_id'),
        'location.j': loc.get('j'),
        'location.i': loc.get('i'),
    }
    mismatches = {name: {'expected': expected[name], 'actual': observed[name]}
                  for name in expected if expected[name] != observed[name]}
    if mismatches:
        print('SPCOA_DIAGNOSTICS_IDENTITY_MISMATCH ' + json.dumps({
            'fields': mismatches,
            'diagnostics_module_file': getattr(met, '__file__', 'unknown'),
            'api_expected_revision': 7,
        }, sort_keys=True, default=str), flush=True)
        raise ValueError('Calculated output identity check failed: ' +
                         ', '.join(sorted(mismatches)) + '; refusing cache upload')
    payload = json.dumps(result, separators=(',', ':'), allow_nan=False).encode('utf-8')
    client.put_object(Bucket=archive.BUCKET,
                      Key=archive.key(run, relative_diag(j, i)), Body=payload,
                      ContentType='application/json',
                      CacheControl='public, max-age=31536000, immutable')
    print(f'COMPUTED {run} native j={j} i={i}: {len(payload)} bytes; '
          f'errors={result.get("calculation_errors", {})}', flush=True)


def _handle_get(event):
    method = (event.get('requestContext', {}).get('http', {}).get('method') or
              event.get('httpMethod') or '').upper()
    if method != 'GET':
        return response(405, {'error': 'GET required'})
    args = event.get('queryStringParameters') or {}
    try:
        run, j, i = _validate(args.get('run'), args.get('j'), args.get('i'))
    except ValueError as exc:
        return response(400, {'error': str(exc)})
    client = s3()
    try:
        _manifest(client, run)
    except ClientError as exc:
        if _is_missing(exc):
            return response(404, {'error': f'No published sounding archive for {run}'})
        raise
    except ValueError as exc:
        return response(404, {'error': str(exc)})
    doc = cached_diagnostics(client, run, j, i)
    if doc is not None:
        # Data response; the browser verifies exact native cell and run again.
        return response(200, doc)
    if not QUEUE_URL:
        return response(503, {'error': 'Sounding worker queue has not been configured'})
    sqs = boto3.client('sqs')
    body = json.dumps({'run': run, 'j': j, 'i': i}, separators=(',', ':'))
    # FIFO dedup suppresses repeated poll requests for the same point for 5 min.
    sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=body,
                     MessageGroupId=f'{run}-j{j}-i{i}',
                     MessageDeduplicationId=f'{run}-j{j}-i{i}')
    return response(202, {'status': 'queued_or_processing', 'run_id': run,
                          'j': j, 'i': i,
                          'retry_after_seconds': RETRY_SECONDS})


def lambda_handler(event, context):
    records = event.get('Records') or []
    if records:
        for record in records:
            if record.get('eventSource') != 'aws:sqs':
                raise ValueError('Unexpected worker event')
            payload = json.loads(record['body'])
            run, j, i = _validate(payload.get('run'), payload.get('j'), payload.get('i'))
            _calculate(run, j, i)
        return {'ok': True, 'processed': len(records)}
    try:
        return _handle_get(event)
    except Exception as exc:
        # Detailed exceptions go to CloudWatch; no stack traces or credentials
        # are returned to unauthenticated browser callers.
        print('SPCOA sounding API exception:', traceback.format_exc(), flush=True)
        return response(503, {'error': 'Diagnostics service temporarily unavailable',
                              'detail': type(exc).__name__})


if __name__ == '__main__':
    # No external dependencies for syntax validation; actual diagnostics are
    # exercised by the existing V4 GitHub Actions single-point workflow.
    print('SPCOA on-demand sounding Lambda entrypoint loaded.')
