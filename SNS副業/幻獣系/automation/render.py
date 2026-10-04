"""Render a daily package: image.png + segments.json -> final.mp4.
Each segment has text and audio (relative WAV/MP3 path), or duration for silent previews.
Silent previews are named preview-silent.mp4 and never marked ready.
"""
import argparse, json, subprocess, sys, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
import imageio_ffmpeg

def run(command):
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def render(folder):
    folder = Path(folder).resolve()
    segments = json.loads((folder / 'segments.json').read_text(encoding='utf-8-sig'))
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    work = folder / 'render'
    work.mkdir(exist_ok=True)
    bg = ImageOps.fit(Image.open(folder / 'image.png').convert('RGB'), (1080, 1920))
    font = ImageFont.truetype('C:/Windows/Fonts/meiryob.ttc', 58)
    has_audio = all(s.get('audio') for s in segments)
    clips = []
    elapsed = 0
    srt = []
    def timestamp(sec):
        ms = round(sec * 1000)
        return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
    for index, segment in enumerate(segments):
        text = segment['text']
        lines, line = [], ''
        for char in text:
            if char == '\n' or font.getlength(line + char) > 860:
                lines.append(line)
                line = '' if char == '\n' else char
            else:
                line += char
        if line: lines.append(line)
        if len(lines) > 5: raise ValueError('Split long subtitle into shorter segments')
        frame = bg.copy().convert('RGBA')
        overlay = Image.new('RGBA', frame.size)
        draw = ImageDraw.Draw(overlay)
        top = 1360 - max(0, len(lines)-2)*72
        draw.rounded_rectangle((70, top-25, 1010, top+len(lines)*82+25), 24, fill=(0, 0, 0, 185))
        for row, value in enumerate(lines):
            draw.text((540, top+row*82), value, font=font, anchor='mt', fill='white', stroke_width=2, stroke_fill='black')
        frame = Image.alpha_composite(frame, overlay).convert('RGB')
        card = work / f'{index:03}.png'
        frame.save(card)
        if index == 0: frame.save(folder / 'preview.jpg')
        clip = work / f'{index:03}.mp4'
        command = [ffmpeg, '-y', '-loop', '1', '-i', str(card)]
        if has_audio:
            audio = folder / segment['audio']
            wav = work / f'{index:03}.wav'
            run([ffmpeg, '-y', '-i', str(audio), '-ar', '24000', '-ac', '1', str(wav)])
            with wave.open(str(wav)) as stream: duration = stream.getnframes()/stream.getframerate()
            command += ['-i', str(wav)]
        else: duration = float(segment.get('duration', max(2, len(text)/6)))
        command += ['-t', str(duration), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
        if has_audio: command += ['-c:a', 'aac', '-ar', '48000', '-ac', '2']
        command += [str(clip)]
        run(command)
        clips.append(f"file '{clip.name}'")
        srt.append(f'{index+1}\n{timestamp(elapsed)} --> {timestamp(elapsed+duration)}\n{text}\n')
        elapsed += duration
    (work / 'concat.txt').write_text('\n'.join(clips), encoding='utf-8')
    output = folder / ('final.mp4' if has_audio else 'preview-silent.mp4')
    run([ffmpeg, '-y', '-f', 'concat', '-safe', '0', '-i', str(work/'concat.txt'), '-c', 'copy', '-movflags', '+faststart', str(output)])
    (folder/'subtitles.srt').write_text('\n'.join(srt), encoding='utf-8')
    (folder/'render-result.json').write_text(json.dumps({'video':output.name,'has_audio':has_audio,'duration':elapsed,'width':1080,'height':1920,'status':'rendered_needs_review' if has_audio else 'silent_preview_only'}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(output)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('folder')
    render(parser.parse_args().folder)
