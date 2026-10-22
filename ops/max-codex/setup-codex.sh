set -eu
install -d -m 755 /opt/workshop-codex-bridge
install -m 644 /opt/workshop-codex/max-codex-broker.mjs /opt/workshop-codex-bridge/max-codex-broker.mjs
install -m 644 /opt/workshop-codex/workshop-codex.service /etc/systemd/system/workshop-codex.service
python3 - <<'PY'
import os,secrets
a='/var/lib/workshop-assistant/broker-token'
b='/opt/finance-pwa/shared/secrets/max-codex-token'
if not os.path.exists(a):
    with open(a,'w') as f:f.write(secrets.token_hex(32)+'\n')
    import pwd
    user=pwd.getpwnam('workshop-assistant');os.chown(a,user.pw_uid,user.pw_gid);os.chmod(a,0o600)
with open(a) as f:value=f.read()
with open(b,'w') as f:f.write(value)
os.chown(b,0,1000);os.chmod(b,0o640)
PY
systemctl daemon-reload
systemctl enable --now workshop-codex.service
systemctl is-active workshop-codex.service
