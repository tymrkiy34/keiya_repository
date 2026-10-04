"""Apply shared per-row registration to already extracted generated artwork."""
from pathlib import Path
import json
from PIL import Image

ROOT=Path(__file__).resolve().parent
frames_root=ROOT/'qa/frames'
report=[]
for folder in sorted(frames_root.iterdir()):
    if not folder.is_dir():
        continue
    files=sorted(folder.glob('*.png'))
    frames=[Image.open(f).convert('RGBA') for f in files]
    bboxes=[f.getbbox() for f in frames]
    if folder.name=='jumping':
        scale=1.0
        bottom=203
    elif folder.name in ['running-right','running-left']:
        scale=1.0
        bottom=max(b[3] for b in bboxes)
    else:
        # One scale for the entire state, matched to the jump landing body.
        scale=140/198
        bottom=max(b[3] for b in bboxes)
    for f,frame in zip(files,frames):
        if folder.name=='jumping':
            continue
        # Transform the whole canvas, preserving each pose's relative displacement.
        newsize=(round(192*scale),round(208*scale))
        resized=frame.resize(newsize,Image.Resampling.LANCZOS)
        target=Image.new('RGBA',(192,208))
        target.alpha_composite(resized,((192-newsize[0])//2,round(203-bottom*scale)))
        target.save(f)
    report.append({'state':folder.name,'shared_scale':scale,'source_baseline':bottom,'target_baseline':203,'preserved_jump':folder.name=='jumping'})
(ROOT/'qa/standard-registration.json').write_text(json.dumps({'ok':True,'rows':report,'reason':'Shared row transforms match seated states to the jump landing height and align directional gait baseline, without per-pose resizing or artwork edits.'},indent=2),encoding='utf-8')
