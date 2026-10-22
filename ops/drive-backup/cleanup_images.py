#!/usr/bin/env python3
"""Remove only obsolete Workshop image tags; never prune containers or volumes."""
import datetime, json, pathlib, subprocess, sys, time
import vps_drive as v

def docker(*args):
    return subprocess.check_output(['docker',*args],text=True).strip()

def created_epoch(value):
    # Docker emits nanoseconds; Python 3.10 accepts at most microseconds.
    return datetime.datetime.fromisoformat(v.re.sub(r'(\.\d{6})\d+',r'\1',value.replace('Z','+00:00'))).timestamp()

def candidates(images, protected_tags, used_ids, now):
    result=[]
    own=sorted([i for i in images if any(v.re.fullmatch(r'finance-pwa:[0-9a-f]{40}',t)
                                        for t in i.get('RepoTags',[]))],key=lambda i:created_epoch(i['Created']),reverse=True)
    newest={i['Id'] for i in own[:2]}
    for i in own:
        tags=i.get('RepoTags',[])
        if i['Id'] in newest or i['Id'] in used_ids or any(t in protected_tags for t in tags):continue
        if not all(v.re.fullmatch(r'finance-pwa:[0-9a-f]{40}',t) for t in tags):continue
        age=now-created_epoch(i['Created'])
        if age<3600:continue
        result.extend(tags)
    return result

def main():
    try:
        with v.locks():
            cfg=json.loads(v.CONFIG.read_text())
            v.validate_hot_copies(cfg)
            protected={'finance-pwa:'+v.APP.resolve().name}
            for p in v.RELEASES.iterdir():
                if not p.is_dir():continue
                v.inventory(p)
                for name in ['new-release','previous-release']:
                    f=p/name
                    if f.exists():protected.add('finance-pwa:'+pathlib.Path(f.read_text().strip()).name)
                f=p/'previous-image'
                if f.exists():protected.add(f.read_text().strip())
            for p in v.SNAPSHOTS.iterdir():
                f=p/'COMPLETE'
                if f.is_file():
                    meta=dict(line.split('=',1) for line in f.read_text().splitlines())
                    protected.add('finance-pwa:'+pathlib.Path(meta['release']).name)
            ids=docker('image','ls','-q','--no-trunc','finance-pwa').splitlines()
            images=json.loads(docker('image','inspect',*sorted(set(ids)))) if ids else []
            used=docker('ps','-aq').splitlines()
            used_ids=set(docker('inspect','--format','{{.Image}}',*used).splitlines()) if used else set()
            plan=candidates(images,protected,used_ids,time.time())
            print(json.dumps({'obsolete_workshop_image_tags':plan}),flush=True)
            for tag in plan:
                # Without force Docker refuses removal when an image became referenced.
                subprocess.run(['docker','image','rm','--no-prune',tag],check=True)
    except BlockingIOError:
        print('Release or backup busy; defer image cleanup',flush=True)

if __name__=='__main__':main()
