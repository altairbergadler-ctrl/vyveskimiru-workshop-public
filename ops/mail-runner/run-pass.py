#!/usr/bin/python3
import datetime, fcntl, hashlib, json, os, pathlib, signal, subprocess, tempfile, uuid
BASE = pathlib.Path('/opt/workshop-mail-runner')
STATE = pathlib.Path('/var/lib/workshop-mail')
os.umask(0o077)
def command(args, **kw):
    payload=kw.pop('input',None); timeout=kw.pop('timeout',None)
    proc=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,**kw)
    try: out,err=proc.communicate(payload,timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid,signal.SIGKILL); proc.communicate(); raise
    return subprocess.CompletedProcess(args,proc.returncode,out,err)
def main():
    lock = open(STATE/'scheduler.lock', 'a')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: return
    aggregate = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status':'error', 'attachments':[], 'questions':[], 'errors':[], 'remaining':None}
    for _ in range(4):
        run_id = str(uuid.uuid4())
        with tempfile.TemporaryDirectory(dir=STATE/'work', prefix='pass-') as work:
            output = pathlib.Path(work)/'result.json'
            prompt = (BASE/'PROMPT.txt').read_text().replace('{RUN_ID}', run_id)
            args = ['/opt/workshop-codex/node_modules/.bin/codex','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check',
                    '-C',work,'-s','danger-full-access','-m','gpt-5.6-terra','-c','model_reasoning_effort="low"',
                    '-c','web_search="disabled"','--color','never','--output-schema',str(BASE/'result.schema.json'),'-o',str(output),'-']
            try:
                result = command(args, input=prompt.encode(), timeout=1050)
                if result.returncode != 0 or not output.exists():
                    # Do not persist model/tool transcripts, credentials, or raw messages.
                    code = 'MODEL_RUN_FAILED'
                    for marker in [b'capacity', b'403', b'401', b'429']:
                        if marker in result.stderr.lower(): code += '_' + marker.decode().upper(); break
                    raise RuntimeError(code)
                item = json.loads(output.read_text())
                for key in ['attachments','questions','errors']: aggregate[key].extend(item[key])
                aggregate.update(status=item['status'], remaining=item['remaining'])
            except subprocess.TimeoutExpired:
                aggregate['errors'].append('MODEL_TIMEOUT'); aggregate['status']='error'; break
            except Exception as exc:
                aggregate['errors'].append(str(exc) if isinstance(exc, RuntimeError) else 'INVALID_RUN_RESULT')
                aggregate['status']='error'; break
            finally:
                # Own RunId only; cannot release another run's lease.
                try:
                    cleanup=command([str(BASE/'mail-delta'),'finish','--run-id',run_id], timeout=45)
                    if cleanup.returncode and b'LEASE_REQUIRED' not in cleanup.stdout:
                        aggregate['errors'].append('FINISH_FAILED')
                except Exception: aggregate['errors'].append('FINISH_FAILED')
        if aggregate['remaining'] == 0 or aggregate['status'] in ['blocked','error']: break
    if aggregate['remaining'] not in [None,0]:
        aggregate['errors'].append('QUEUE_REMAINING'); aggregate['status']='error'
    if 'FINISH_FAILED' in aggregate['errors']: aggregate['status']='error'
    fingerprint=hashlib.sha256(json.dumps([aggregate['questions'],aggregate['errors']],ensure_ascii=False).encode()).hexdigest()
    previous={}
    try: previous=json.loads((STATE/'last-result.json').read_text())
    except FileNotFoundError: pass
    aggregate['decision']='NOTIFY' if aggregate['attachments'] or ((aggregate['questions'] or aggregate['errors']) and fingerprint != previous.get('problemFingerprint')) else 'DONT_NOTIFY'
    aggregate['problemFingerprint']=fingerprint
    data=json.dumps(aggregate,ensure_ascii=False,indent=2)
    (STATE/'last-result.json.tmp').write_text(data)
    os.replace(STATE/'last-result.json.tmp',STATE/'last-result.json')
    # Bounded summaries only; no email bodies or tool output.
    history=STATE/'results.jsonl'
    lines=history.read_text().splitlines()[-199:] if history.exists() else []
    lines.append(json.dumps(aggregate,ensure_ascii=False))
    history.write_text('\n'.join(lines)+'\n')
    print(json.dumps({'status':aggregate['status'],'decision':aggregate['decision'],'remaining':aggregate['remaining'],'attachments':len(aggregate['attachments']),'questions':len(aggregate['questions']),'errors':len(aggregate['errors'])}))
    if aggregate['status']=='error': raise SystemExit(1)
if __name__=='__main__': main()
