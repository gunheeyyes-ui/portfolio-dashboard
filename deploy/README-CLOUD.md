# Private cloud deployment

The dashboard runs as a systemd service on Ubuntu and is exposed only through
Tailscale Serve. Do not open TCP 5177 in the Lightsail firewall.

Secrets live in `/etc/portfolio-dashboard.env` with mode `600`. Never copy the
local `.env` into a Git repository or public storage.

Useful commands:

```bash
sudo systemctl status portfolio-dashboard
sudo journalctl -u portfolio-dashboard -n 100 --no-pager
sudo systemctl restart portfolio-dashboard
tailscale serve status
```
