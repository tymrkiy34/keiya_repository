"""Check a rendered package and export one video frame per subtitle for review."""
import argparse, array, json, math, re, subprocess, sys, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, str(Path(__file__).parent/'vendor'))
import imageio_ffmpeg

def validate(folder):
    folder = Path(folder).resolve()
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    segments = json.loads((folder/'segments.json').read_text(encoding='utf-8-sig'))
    probe = subprocess.run([exe,'-hide_banner','-i',str(folder/'final.mp4'),'-f','null','-'],capture_output=True,text=True,encoding='utf-8',errors='replace')
    if probe.returncode: raise RuntimeError(probe.stderr)
    match = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)',probe.stderr)
    duration = int(match[1])*3600+int(match[2])*60+float(match[3])
    assert '1080x1920' in probe.stderr, 'Unexpected video resolution'
    assert re.search(r'30 fps',probe.stderr), 'Unexpected frame rate'
    assert 'Audio:' in probe.stderr, 'Missing audio stream'
    script = (folder/'script.txt').read_text(encoding='utf-8-sig')
    assert re.sub(r'\s','',script) == re.sub(r'\s','',''.join(x['text'] for x in segments)), 'Subtitles differ from script'
    font = ImageFont.truetype('C:/Windows/Fonts/meiryob.ttc',58)
    frames = folder/'qa-frames'
    frames.mkdir(exist_ok=True)
    sheet = Image.new('RGB',(1080,math.ceil(len(segments)/3)*670),(15,20,25))
    draw = ImageDraw.Draw(sheet)
    elapsed, audio_checks = 0.0, []
    for index, segment in enumerate(segments):
        for line in segment['text'].splitlines():
            assert font.getlength(line) <= 860, f'Subtitle {index+1} requires shorter line breaks'
        with wave.open(str(folder/segment['audio'])) as stream:
            part_duration = stream.getnframes()/stream.getframerate()
            assert stream.getsampwidth()==2, 'Expected 16-bit WAV'
            samples = array.array('h',stream.readframes(stream.getnframes()))
            rms = math.sqrt(sum(x*x for x in samples)/len(samples))
            assert rms>10, f'Silent audio segment {index+1}'
        audio_checks.append({'index':index+1,'seconds':part_duration,'rms':round(rms,1)})
        frame = frames/f'{index+1:02}.jpg'
        subprocess.run([exe,'-y','-ss',str(elapsed+part_duration/2),'-i',str(folder/'final.mp4'),'-frames:v','1',str(frame)],capture_output=True,check=True)
        image = Image.open(frame)
        image.thumbnail((360,640))
        x,y = index%3*360,index//3*670
        sheet.paste(image,(x,y))
        draw.text((x+10,y+644),f'{index+1:02} / {elapsed:.1f}s',fill='white')
        elapsed += part_duration
    assert abs(duration-elapsed)<0.5, 'Video/audio duration mismatch'
    sheet.save(folder/'contact-sheet.jpg')
    result = {'full_decode':True,'resolution':[1080,1920],'fps':30,'duration_seconds':duration,'source_audio_seconds':elapsed,'duration_difference':round(duration-elapsed,3),'script_matches_subtitles':True,'subtitle_width_check':True,'audio_segments':audio_checks,'visual_review':'pending','listening_review':'not_performed'}
    (folder/'qa.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'duration_seconds':duration,'segments':len(segments),'full_decode':True}))

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('folder')
    validate(parser.parse_args().folder)
