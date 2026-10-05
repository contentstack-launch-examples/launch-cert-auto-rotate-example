# launch-cert-rotate

Keep a free **Let's Encrypt** certificate on your **Contentstack Launch** custom domain renewed and uploaded automatically.

> [!NOTE]
> **This is an example, not an official Contentstack product.** It is built for **certbot + Hostinger DNS** and was tested on macOS. Use it as a starting point and adapt it to your own setup; see [Adapting it](#adapting-it).

```sh
sudo launch-cert-rotate setup     # once: answer a few questions
sudo launch-cert-rotate renew     # any time (it also runs on its own, twice a day)
sudo launch-cert-rotate status    # check the certificate
```

## How it works

1. **certbot** gets the certificate from Let's Encrypt. It proves you own the domain with a temporary DNS record, which this tool creates and removes through the **Hostinger API**.
2. **launch-cert-rotate** uploads the certificate to Launch, waits until Launch reports SSL as active, and reads the domain back to confirm the new expiry date.
3. **A schedule** (launchd on macOS, cron on Linux) runs `renew` twice a day. certbot renews about 30 days before expiry; all other runs do nothing.

Before uploading, the tool checks that the key matches, the certificate is valid, it covers the domain, and the chain is complete. If Launch already has the certificate, nothing is uploaded.

## What you need

- **A Mac or Linux machine that is always on.** It does not serve your site; Launch does.
- **Node.js 20.12+** and **certbot**. On macOS: `brew install node certbot`.
- **Your domain's DNS hosted at Hostinger**, and a Hostinger API token (hPanel → Profile → API).
- **The domain added in Launch** (Settings → Domains).
- **The authtoken** of the Contentstack user that manages the domain, plus your **organization, project and environment UIDs**:
  - Organization UID: Contentstack → **Org Admin → Info**.
  - Project and environment UIDs: open the environment in Launch. Both are in the browser URL, after `projects/` and `environments/`.

> [!IMPORTANT]
> Domains whose DNS is hosted on **Cloudflare** are not supported. Launch runs on Cloudflare, and a Cloudflare-hosted domain pointing at Launch (Cloudflare to Cloudflare) needs a separate setup.

## Install and set up

```sh
git clone <repo-url> launch-cert-rotate
cd launch-cert-rotate
npm install              # also builds
npm install -g .

sudo launch-cert-rotate setup
```

Setup asks for each value and checks it before moving on:

1. Checks that certbot is installed.
2. Connects to Launch with your host, authtoken and UIDs.
3. Lets you pick the domains to secure from your Launch environment.
4. Checks your Hostinger API token.
5. Gets the certificate and uploads it to Launch. If a domain is on Launch's automatic SSL, it asks before switching.
6. Schedules automatic renewal.

Your answers are saved in `/etc/launch-cert-rotate/env` (readable by root only). Re-running setup shows them as defaults, so you can add a domain or change a token at any time.

## Day to day

| I want to… | Run |
| --- | --- |
| Check the certificate | `sudo launch-cert-rotate status` |
| Renew now if due | `sudo launch-cert-rotate renew` |
| Test renewal without changing anything | `sudo launch-cert-rotate renew --dry-run` |
| Get a new certificate today | `sudo launch-cert-rotate renew --force` |
| Change domains or tokens | `sudo launch-cert-rotate setup` |

Add `--debug` to see every API request; tokens and keys are always hidden.

**Logs:** the schedule logs to `/var/log/launch-cert-rotate.log`, and certbot logs to `/var/log/letsencrypt/letsencrypt.log`.

If an upload ever fails (for example, Launch was unreachable), the next `renew` uploads the certificate again.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `must run as root` / `readable by root only` | Prefix the command with `sudo`. |
| `certbot is not installed` | `brew install certbot` (macOS) or `sudo snap install --classic certbot` (Linux). |
| `Hostinger rejected the API token` | Create a new token in hPanel → Profile → API, then re-run setup. |
| `certbot could not get the certificate` | Check that the domain's DNS is hosted at Hostinger. Details are in `/var/log/letsencrypt/letsencrypt.log`. |
| HTTP 401 / 403 from Launch | The authtoken is wrong or expired, or the user lacks access. Re-run setup. |
| `the domain itself is not live yet` | The certificate is fine, but the domain's DNS isn't pointing at Launch yet. Add the records shown in Launch → Domains. |

## Adapting it

The code is small (`src/`, about 1,000 lines). The usual changes:

| To use… | Change |
| --- | --- |
| **Another DNS provider** | Replace [src/hostinger.ts](src/hostinger.ts) with your provider's API, or pass a [certbot DNS plugin](https://eff-certbot.readthedocs.io/en/stable/using.html#dns-plugins) instead of `--manual …` in [src/setup.ts](src/setup.ts). |
| **Another ACME client** (lego, acme.sh) | Call `uploadIfNewer()` from [src/rotate.ts](src/rotate.ts) with your certificate files. |
| **Your own scheduler** | Run `sudo launch-cert-rotate renew --quiet` daily from it. |
| **A secret manager** | Generate `/etc/launch-cert-rotate/env` from it. [.env.example](.env.example) lists the keys. |

The Launch API requests are in [docs/launch-domains-api.postman_collection.json](docs/launch-domains-api.postman_collection.json).

| File | Role |
| --- | --- |
| [src/cli.ts](src/cli.ts) | Commands |
| [src/setup.ts](src/setup.ts) | The setup wizard |
| [src/rotate.ts](src/rotate.ts) | Upload and verify |
| [src/cert.ts](src/cert.ts) | Certificate checks |
| [src/launchClient.ts](src/launchClient.ts) | Launch API |
| [src/hostinger.ts](src/hostinger.ts) | Hostinger DNS hook for certbot |
| [src/certbot.ts](src/certbot.ts) | certbot and scheduling |
| [src/config.ts](src/config.ts) | Settings file |
| [src/prompt.ts](src/prompt.ts) | Questions |
| [src/logger.ts](src/logger.ts) | Logging with secrets hidden |
| [src/errors.ts](src/errors.ts) | Errors |

## Uninstall

```sh
sudo launchctl bootout system/com.contentstack.launch-cert-rotate 2>/dev/null   # macOS
sudo rm -f /Library/LaunchDaemons/com.contentstack.launch-cert-rotate.plist /etc/cron.d/launch-cert-rotate
sudo rm -rf /etc/launch-cert-rotate
npm uninstall -g launch-cert-rotate
```

Certificates stay in `/etc/letsencrypt`; remove one with `sudo certbot delete --cert-name <domain>`. Launch keeps serving the last uploaded certificate until it expires, or until you switch the domain back to automatic SSL in Launch.

## License

[MIT](LICENSE)
