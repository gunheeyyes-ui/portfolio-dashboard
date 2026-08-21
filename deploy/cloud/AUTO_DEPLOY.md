# GitHub main → OCI automatic deployment

This production server intentionally keeps secrets and personal holdings outside Git:

- public code: `https://github.com/gunheeyyes-ui/portfolio-dashboard`, branch `main`
- app directory: `/opt/portfolio-dashboard`
- local-only files preserved as untracked/ignored: `portfolio.js`, `free-float.json`, `.env` if present
- secrets: `/etc/portfolio-dashboard.env`
- persistent runtime/OOS data: `/var/lib/portfolio-dashboard`

## One-time bootstrap on the OCI server

After the auto-deploy files have been merged to GitHub `main`, run this once on OCI:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/gunheeyyes-ui/portfolio-dashboard/main/deploy/cloud/bootstrap-auto-deploy.sh \
  -o /tmp/bootstrap-auto-deploy.sh
sudo bash /tmp/bootstrap-auto-deploy.sh
```

The bootstrap:

1. backs up the entire current `/opt/portfolio-dashboard` code tree;
2. backs up persistent dashboard/OOS data;
3. preserves local-only `portfolio.js`, `free-float.json`, and `.env` when present;
4. converts `/opt/portfolio-dashboard` into a Git checkout of public `main`;
5. runs Node syntax checks and `npm test`;
6. restarts `portfolio-dashboard` and verifies `/api/health`;
7. enables `portfolio-dashboard-autodeploy.timer` only after the health check succeeds.

If bootstrap validation or health fails, the pre-bootstrap code tree is restored and the auto-deploy timer is not left enabled.

## Normal operation

The systemd timer checks GitHub `main` about every two minutes. `deploy/cloud/update.sh` does nothing when the SHA is unchanged. For a new fast-forward commit it performs:

```text
persistent-data backup
→ fast-forward-only Git update
→ syntax checks
→ npm test
→ systemctl restart portfolio-dashboard
→ local /api/health check
→ automatic git rollback + restart on failure
```

Automatic deployment is deferred on weekdays from **15:20 through 16:29 KST** so the 15:50 EOD full refresh and immutable OOS snapshots cannot be interrupted by a restart. A deferred commit is picked up automatically after 16:30 KST.

If a commit fails syntax/tests/health, its SHA is quarantined in `/var/lib/portfolio-dashboard/auto-deploy-failed-sha`. The timer will not retry that same bad commit every two minutes; it waits until GitHub `main` advances to a newer SHA, then makes one fresh attempt.

No GitHub secret, inbound webhook, public port, or self-hosted Actions runner is required. OCI only makes outbound HTTPS requests to GitHub.

## Status / logs

```bash
systemctl status portfolio-dashboard-autodeploy.timer --no-pager
systemctl list-timers portfolio-dashboard-autodeploy.timer --no-pager
journalctl -u portfolio-dashboard-autodeploy.service -n 100 --no-pager
cd /opt/portfolio-dashboard && git status --short && git log -1 --oneline
curl -fsS http://127.0.0.1:5177/api/health
```

## Manual deployment / retry

```bash
sudo DASHBOARD_GIT_BRANCH=main bash /opt/portfolio-dashboard/deploy/cloud/update.sh
```

To deliberately retry a quarantined SHA after fixing an environment-only problem, remove the marker first:

```bash
sudo rm -f /var/lib/portfolio-dashboard/auto-deploy-failed-sha
sudo DASHBOARD_GIT_BRANCH=main bash /opt/portfolio-dashboard/deploy/cloud/update.sh
```

## Disable automatic deployment

```bash
sudo systemctl disable --now portfolio-dashboard-autodeploy.timer
```

This does not stop the dashboard itself; it only stops automatic GitHub update checks.
