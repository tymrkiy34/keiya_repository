"""Create 青山龍星 narration for segments.json using the local VOICEVOX engine."""
import argparse, json, os, subprocess, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = 'http://127.0.0.1:50021'
ENGINE = Path(os.environ['LOCALAPPDATA']) / 'Programs/VOICEVOX/vv-engine/run.exe'

def request(path, data=None):
    req = urllib.request.Request(BASE+path, data=data, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.read()

def ensure_engine():
    try:
        return json.loads(request('/speakers'))
    except (OSError, urllib.error.URLError):
        if not ENGINE.is_file(): raise RuntimeError('VOICEVOX engine is missing')
        logs = ROOT/'logs'
        logs.mkdir(exist_ok=True)
        with (logs/'voicevox-out.log').open('ab') as out, (logs/'voicevox-err.log').open('ab') as err:
            process = subprocess.Popen([str(ENGINE), '--host','127.0.0.1','--port','50021','--output_log_utf8','--disable_mutable_api'], cwd=ENGINE.parent, stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(60):
            time.sleep(1)
            if process.poll() is not None: raise RuntimeError('VOICEVOX engine exited; inspect automation/logs')
            try: return json.loads(request('/speakers'))
            except (OSError, urllib.error.URLError): pass
        raise RuntimeError('VOICEVOX engine did not become ready')

def narrate(folder):
    folder = Path(folder).resolve()
    speakers = ensure_engine()
    speaker = next(s for s in speakers if s['name'] == '青山龍星')
    style = next(s for s in speaker['styles'] if s['name'] == 'ノーマル')
    segments_path = folder/'segments.json'
    segments = json.loads(segments_path.read_text(encoding='utf-8-sig'))
    (folder/'audio').mkdir(exist_ok=True)
    for index, segment in enumerate(segments):
        params = urllib.parse.urlencode({'speaker':style['id'], 'text':segment.get('speech', segment['text']).replace('\n','')})
        query = json.loads(request('/audio_query?'+params, b''))
        query.update(speedScale=1.0, pitchScale=0.0, volumeScale=1.0, outputSamplingRate=24000, outputStereo=False)
        wav = request('/synthesis?'+urllib.parse.urlencode({'speaker':style['id']}), json.dumps(query).encode())
        target = folder/'audio'/f'{index+1:03}.wav'
        temp = target.with_suffix('.tmp')
        temp.write_bytes(wav)
        temp.replace(target)
        segment['audio'] = target.relative_to(folder).as_posix()
        print(f'Audio {index+1}/{len(segments)}', flush=True)
    segments_path.write_text(json.dumps(segments,ensure_ascii=False,indent=2),encoding='utf-8')
    (folder/'voice.json').write_text(json.dumps({'name':speaker['name'],'speaker_uuid':speaker['speaker_uuid'],'style':style['name'],'style_id':style['id'],'speedScale':1,'pitchScale':0,'volumeScale':1,'credit':'VOICEVOX:青山龍星'},ensure_ascii=False,indent=2),encoding='utf-8')
    (folder/'credits.txt').write_text('VOICEVOX:青山龍星\n',encoding='utf-8')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('folder')
    narrate(parser.parse_args().folder)
