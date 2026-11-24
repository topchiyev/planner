# Native Planner installation

Planner installs on Ubuntu 24.04 amd64 with AVX support. Review and verify the release manifest against the trusted signing key before installing its `.deb`. The host needs the package dependencies already available for an offline installation. Use the existing [packaging guide](packaging.md) to verify a candidate.

```sh
sudo dpkg -i ./planner-workspace_0.1.0_amd64.deb
plannerctl preflight --public-url https://planner.example.test --json
```

The installer checks the host, available space, dedicated service identities, configuration and state ownership, release paths, and both selected TCP ports before unpacking. It checks listeners without connecting to them. The default application and MongoDB ports are `27430` and `27431`. If a default port is busy and setup will use different ports, supply the alternate ports at installation and pass the same pair to preflight and setup.

```sh
sudo env PLANNER_INSTALL_APP_PORT=27530 PLANNER_INSTALL_DB_PORT=27531 \
  dpkg -i ./planner-workspace_0.1.0_amd64.deb
plannerctl preflight --public-url https://planner.example.test --app-port 27530 --db-port 27531
```

Preflight reports the supported host, available storage, selected port status, installation and ownership state, installed CLI version, and whether the runtime is configured. The current unconfigured runtime reports unavailable. Preflight makes no health request to a listener and starts no processes beyond its local checks. The installer requires at least 512 MiB of free space on the release and state filesystems. Workspace data and backups need additional capacity based on the installation’s size.

| Installed location | Owner and access |
| --- | --- |
| `/opt/planner/releases/` and `/opt/planner/current` | Root-owned application and private runtimes. Services run with the release mounted read-only. |
| `/etc/planner` | `root:root` mode `0711`. The known configuration files are separately restricted to their respective service groups. |
| `/var/lib/planner` | `root:root` mode `0711`. Root-owned matching install receipts distinguish Planner’s managed state from an unrelated directory. |
| `/var/lib/planner/mongodb` | `planner-mongodb:planner-mongodb` mode `0700`. |
| `/var/lib/planner/blobs`, `/var/lib/planner/staging`, `/var/lib/planner/backups` | `planner:planner` mode `0700`. |
| `/run/planner` | `planner:planner` mode `0750`, recreated after a reboot by systemd tmpfiles. |

Both service accounts are dedicated non-login system identities. Installing or reinstalling lays down `planner.service` and `planner-mongodb.service` without enabling or starting them. The installer reloads a running systemd manager so it sees the new units. MongoDB’s unit requires `mongod.conf`, and the backend unit requires both configuration files. Setup starts and verifies the private database before starting the backend. An occupied selected port causes installation to stop before unpacking, including when a running Planner instance still owns its port. Stop Planner’s own services through the operator workflow before reinstalling on their selected ports. The package leaves unrelated MongoDB installations on `27017` in place. If an occupied path or systemd definition belongs to another installation, resolve it before retrying. Planner checks exact package ownership and rejects service-specific drop-ins and higher-priority tmpfiles overrides that could change the runtime directory.

## Offline acceptance

The [native installation test](../tests/release/native-installation.sh) runs as root in a disposable Ubuntu guest with networking disabled. Attach a read-only ISO containing the signed candidate and its test public key at the root, plus the signed prior package and its test public key under `previous/`. The script takes the ISO mount path. It verifies both signatures, checks failed installs and upgrades, and then installs and reinstalls the candidate while an independently owned MongoDB sentinel runs on port `27017`.
