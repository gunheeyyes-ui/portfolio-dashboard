# Always-on private cloud deployment

## Architecture

- Code: `/opt/portfolio-dashboard`
- Persistent snapshot/tracker data: `/var/lib/portfolio-dashboard`
- Runtime cache: `/var/cache/portfolio-dashboard`
- Secrets: `/etc/portfolio-dashboard.env` (`0640`, root-owned)
- Service: `portfolio-dashboard.service`
- Access: Tailscale Serve to `127.0.0.1:5177`; never public port 5177

The browser reads the last-known-good snapshot immediately. A refresh runs in one background single-flight job. Intraday refreshes update current quote fields while retaining the last full ranking; the full EOD job runs from 15:50 KST. Failed or non-trading-day refreshes do not replace the saved snapshot.

## OCI Always Free preparation

Use the OCI home region and select only a shape explicitly marked **Always Free eligible** in the current tenancy console. Capacity and eligibility vary by tenancy and region. Do not select a paid fallback. Current official references:

- <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm>
- <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>

The app has no native npm dependencies and supports Node.js 20 on both ARM64 and x86_64. Create an Ubuntu or Oracle Linux VM, add an SSH key, and allow SSH only for bootstrap. Do not open port 5177.

## First install

Clone the private repository into `/opt/portfolio-dashboard`, check out `cloud-dashboard`, and run:

```bash
cd /opt/portfolio-dashboard
sudo bash deploy/cloud/install.sh
sudoedit /etc/portfolio-dashboard.env
sudo systemctl start portfolio-dashboard
sudo systemctl status portfolio-dashboard --no-pager
curl -fsS http://127.0.0.1:5177/api/health
```

The environment file must contain the KIS keys and account configuration. Never commit that file. The install script creates only empty placeholders.

## Private phone access

```bash
sudo tailscale up
sudo tailscale serve --bg http://127.0.0.1:5177
tailscale serve status
```

Complete the displayed browser authentication step, sign in to Tailscale on the phone, and open the private HTTPS URL. See `tailscale-notes.md`.

## Operations

```bash
sudo systemctl status portfolio-dashboard --no-pager
sudo journalctl -u portfolio-dashboard -n 200 --no-pager
curl -fsS http://127.0.0.1:5177/api/health
curl -fsS http://127.0.0.1:5177/api/refresh-status
curl -fsS -X POST http://127.0.0.1:5177/api/refresh
```

Structured journal events include `REFRESH_START`, `REFRESH_SUCCESS`, `REFRESH_FAIL`, `REFRESH_SKIPPED_LOCK`, `SNAPSHOT_LOADED`, and `SNAPSHOT_WRITTEN`. Logs and APIs do not include KIS keys or account numbers.

## Update and rollback

```bash
cd /opt/portfolio-dashboard
sudo DASHBOARD_GIT_BRANCH=cloud-dashboard bash deploy/cloud/update.sh
```

The updater uses a fast-forward-only pull, runs syntax/tests, restarts the service, and checks the intended local health endpoint. If the health check fails, it restores the previous commit and restarts. For a manual rollback:

```bash
cd /opt/portfolio-dashboard
sudo git checkout --detach <known-good-commit>
sudo systemctl restart portfolio-dashboard
```

## Backup and restore

```bash
sudo bash deploy/cloud/backup.sh
sudo systemctl stop portfolio-dashboard
sudo tar -C /var/lib/portfolio-dashboard -xzf /var/backups/portfolio-dashboard/<backup>.tar.gz
sudo chown -R portfolio-dashboard:portfolio-dashboard /var/lib/portfolio-dashboard
sudo systemctl start portfolio-dashboard
```

Deployment updates never remove `/var/lib/portfolio-dashboard`. Back up `latest-snapshot.json` and `ranking-live-history.jsonl` regularly.
