"""Render supplemental previews strictly from the final encoded atlas."""
from pathlib import Path
import sys
import subprocess
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'tools'))
import imageio_ffmpeg

STATES = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']
COUNTS = [6,8,8,4,5,8,6,6,6]
atlas = Image.open(ROOT / 'final/spritesheet-extended.png').convert('RGBA')
out = ROOT / 'previews/final'
out.mkdir(parents=True, exist_ok=True)
frames_root = ROOT / 'qa/final-frames'
all_frames = []
all_durations = []
def cell(row, col):
    return atlas.crop((col*192,row*208,(col+1)*192,(row+1)*208))
def visible(frame):
    result = Image.new('RGB', frame.size, '#f1ede6')
    result.paste(frame, mask=frame.getchannel('A'))
    return result
for row, (state, count) in enumerate(zip(STATES, COUNTS)):
    folder = frames_root / state
    folder.mkdir(parents=True, exist_ok=True)
    for col in range(count):
        frame = cell(row, col)
        frame.save(folder / f'{col:02d}.png')
        panel = Image.new('RGB', (384,448), '#f1ede6')
        panel.paste(visible(frame).resize((384,416)), (0,32))
        ImageDraw.Draw(panel).text((12,10), f'{state}  frame {col+1}/{count}', fill='#222222')
        all_frames.append(panel)
        all_durations.append(200)
all_frames[0].save(out/'all-states.gif', save_all=True, append_images=all_frames[1:], duration=all_durations, loop=0)
jump_frames = [visible(cell(0,i)) for i in range(6)] + [visible(cell(4,i)) for i in range(5)] + [visible(cell(0,i)) for i in range(6)]
jump_frames[0].save(out/'idle-jump-idle.gif', save_all=True, append_images=jump_frames[1:], duration=160, loop=0)
look_frames = [visible(cell(9+i//8,i%8)) for i in range(16)]
look_frames[0].save(out/'look-loop.gif', save_all=True, append_images=look_frames[1:], duration=220, loop=0)
proof = Image.new('RGB', (192*4,240), '#f1ede6')
for index,(row,col,label) in enumerate([(0,0,'idle'),(3,2,'wave'),(4,2,'jump'),(8,3,'review')]):
    proof.paste(visible(cell(row,col)), (index*192,32))
    ImageDraw.Draw(proof).text((index*192+10,10),label, fill='#222222')
proof.save(out/'motion-stills.png')
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
process = subprocess.Popen([ffmpeg,'-y','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s','384x448','-r','10','-i','-','-an','-c:v','libx264','-pix_fmt','yuv420p', str(out/'all-states.mp4')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
for frame in all_frames:
    process.stdin.write(frame.tobytes())
    process.stdin.write(frame.tobytes())
process.stdin.close()
stderr=process.stderr.read().decode(errors='replace')
code=process.wait()
if code:
    raise RuntimeError(stderr)
(out/'preview-manifest.json').write_text(json.dumps({'ok':True,'source':str(ROOT/'final/spritesheet-extended.png'),'frames_root':str(frames_root),'artifacts':[p.name for p in out.iterdir() if p.is_file()]},indent=2),encoding='utf-8')
print(json.dumps({'ok':True,'output':str(out)}))
