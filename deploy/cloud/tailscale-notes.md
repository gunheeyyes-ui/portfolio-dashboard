# Tailscale private access

The dashboard listens only on `127.0.0.1:5177`. Do not add a public ingress rule for port 5177.

After the VM service is healthy:

```bash
sudo tailscale up
```

Open the authentication URL printed by that command and approve the VM in the same tailnet as the phone. Then run:

```bash
sudo tailscale serve --bg http://127.0.0.1:5177
tailscale serve status
tailscale status
```

Install and sign in to Tailscale on the phone. Open the private HTTPS URL shown by `tailscale serve status`.

Keep only the minimum temporary SSH ingress required to bootstrap the VM. Prefer Tailscale SSH after enrollment. Tailscale authentication is an explicit user step; the install script does not attempt it.
