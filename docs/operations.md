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
| `/run/planner-proxy` | `planner:planner` mode `0711`, recreated after a reboot by systemd tmpfiles. The Planner service alone can replace its HTTP socket. |

Both service accounts are dedicated non-login system identities. Installing or reinstalling lays down `planner.service` and `planner-mongodb.service` without enabling or starting them. The installer reloads a running systemd manager so it sees the new units. MongoDB’s unit requires `mongod.conf`, and the backend unit requires both configuration files. Setup starts and verifies the private database before starting the backend. An occupied selected port causes installation to stop before unpacking, including when a running Planner instance still owns its port. Stop Planner’s own services through the operator workflow before reinstalling on their selected ports. The package leaves unrelated MongoDB installations on `27017` in place. If an occupied path or systemd definition belongs to another installation, resolve it before retrying. Planner checks exact package ownership and rejects service-specific drop-ins and higher-priority tmpfiles overrides that could change the runtime directory.

## Private database initialization

The internal database initialization step runs as root under an exclusive lock on the managed configuration directory. It validates the package receipts, installed service accounts, data directory and selected TCP port before it initializes a database. The application setup workflow invokes this step with its validated database port.

The temporary MongoDB process uses the dedicated `planner-mongodb` account and listens on a Unix socket in a mode `0700` directory. Initialization verifies the application account’s exact `readWrite` role on the `planner` database and matches its installation claim to the singleton database UUID. The temporary administrator is retired before systemd starts the permanent private MongoDB service on IPv4 loopback with authorization enabled and the localhost authentication exception disabled.

The backend authenticates through the permanent Unix socket in `/run/planner-mongodb` after checking the socket namespace and the TCP listener owned by the MongoDB unit. The runtime directory permits local traversal and limits changes to the database service identity. MongoDB applies authentication on both endpoints.

| File | Purpose and access |
| --- | --- |
| `/etc/planner/mongodb-init.json` | Root-only initialization journal that binds retries to the package receipt, data directory, database UUID and port. The journal drops the temporary administrator credential when provisioning completes. |
| `/etc/planner/mongodb-app.json` | Application database credential and expected UUID, owned by `root:planner` with mode `0640`. |
| `/etc/planner/mongod.conf` | Permanent MongoDB configuration, published after private bootstrap stops. It is owned by `root:planner-mongodb` with mode `0640`. |

Retry an interrupted initialization with the same port and managed data directory. Changing the port or replacing the data directory requires a supported operator workflow. Readiness checks the permanent listener’s service identity and the database UUID and account role. Public readiness stays unavailable through incomplete setup, schema checks and recovery.

## Configure and operate Planner

Run setup as root and pass the canonical public HTTPS origin. Omit the port flags to use `27430` for the application and `27431` for MongoDB. Both selected ports must be within the range the service accounts can bind on the host.

```sh
sudo plannerctl setup --mode fresh --public-url https://planner.example.test
sudo plannerctl status --json
sudo plannerctl restart
```

Fresh setup prints a local first-administrator enrollment grant that expires 30 minutes after issuance. Protect the setup output as a credential. If setup is interrupted, repeat the same command with the original mode, origin and ports. The root-only setup intent lets Planner resume and deliver the same unexpired, unconsumed grant. MongoDB stores its digest, issuance time, expiry and installation and enrollment generation identities. Status omits the grant and database credentials.

After configuring the HTTPS reverse proxy, open `/recover` at the configured public origin. Enter the grant, the administrator’s name and email, and a password of 12 to 128 characters. Planner confirms account creation and directs you to sign in separately. The grant can activate only that fresh setup. A retry of `plannerctl setup` with the original settings reports completed setup without printing a new grant. If the service stops during the request, start it again to recover a claimed grant and finish enrollment. The installation stays unavailable until that recovery succeeds. Use the same HTTPS origin for sign-in and the workspace. Status reports unknown setup progress while the owned database is unavailable.

Planner uses a host-only secure browser session cookie. The initial account has a 12-hour inactivity timeout and every session expires at most 30 days after sign-in. Signing out revokes the current browser session on the server. Public readiness can report that the application is ready after activation. Workspace pages, files and account data require a current session. Sign-in failures share the same response and attempts are limited by normalized identifier and the verified proxy client address.

In Account settings, open **Manage multifactor authentication** to enroll an authenticator. Copy the setup key into the authenticator and verify its current six-digit code. Save the ten recovery codes when Planner displays them. Each code can be used once. Replacing the list or disabling the authenticator requires the current password and an authenticator or recovery code. A password-only session expires when enrollment completes. After a successful second factor, you may trust that browser for up to 30 days. Account security lists your trusted browsers and lets you revoke them.

Native setup and start bind an installation-specific key in `/etc/planner/mfa-key.json`. The file belongs to root and is readable by the Planner service group. If it disappears or differs from the installation binding, Planner refuses to start until the correct key is restored. Keep that key with the installation’s protected secrets.

An approved, recovered administrator in a staged import can enroll through `/enroll-mfa` with the enrollment ticket. Completing this step preserves the imported identity and leaves the workspace inactive until operator cutover.


Use `--mode import` to prepare an installation for migration preflight. It records that pending action and leaves the active generation unset. Both modes keep workspace readiness unavailable while their respective setup steps are pending.

Setup and `plannerctl start` verify the dedicated MongoDB instance, start the application on its selected loopback port and enable the two services for boot. `plannerctl stop` stops the application before MongoDB. `plannerctl restart` applies that order and revalidates the database before starting the application again.

Setup and lifecycle commands serialize through the installation lock. Stopped setup and schema migration also take the exclusive writer lease on the existing `/run/planner` directory inode and release it before the backend starts. A running backend holds that same lease through shutdown. Stop, restart and removal drain the backend and obtain the writer lease before touching MongoDB. Setup retries and start against running services verify existing state without provisioning or migrating it. If MongoDB is stopped while the backend is running, `plannerctl start` drains the backend before taking the writer lease and restoring both services. The runtime mount and the host use the same inode, anchored by the root-owned `/run` parent.

Stop Planner before a package upgrade or reinstall. Once configured, the installer checks the recorded ports automatically. Package removal stops and disables the services and preserves the configuration, database and files. After reinstalling, run `sudo plannerctl start` to resume the existing installation. The setup intent and package ports are root-only files under `/etc/planner`; the application configuration is readable by the Planner service group.


## Preparing and preflighting a PLANKA capture

Use an operator-managed, quiescent PLANKA Community 2.3.0 or 2.3.1 capture. Pair a standalone database dump and its matching asset snapshot before restoring either. Keep the original backup and source deployment together for rollback.

Assemble a tar or gzip-compressed tar containing `manifest.json`, `asset-manifest.json` and exactly one of `source.dump` (PostgreSQL custom) or `source.sql` (standalone plain SQL). For materialized assets, put the exact keys under `assets/`. For a versioned object snapshot, include only the manifests and the database dump. The [migration contract](../openspec/changes/launch-planner-v0-1/migration.md#source-baseline-and-inputs) defines the capture fields, file patterns and independent checksums. The asset manifest has `formatVersion: 1` and `files` entries with `key`, `size` and `sha256`. Object entries additionally carry the exact `versionId` to read.

Use an archive file in a root-owned mode-0700 directory and an existing root-owned mode-0700 work directory. Keep both under trusted parents. Prepare validates the complete archive before extracting any entries and publishes a new private capture directory. It leaves the original named archive intact.

```sh
sudo plannerctl migration prepare --archive /root/planka-capture/incoming.tar.gz \
  --work-dir /root/planka-capture/work --json
```

Restore the reported dump into a dedicated database in a disposable PostgreSQL 17 instance through a private Unix socket. Use `pg_restore` for the custom format and `psql -X -v ON_ERROR_STOP=1 -f` for the standalone SQL format. If the upstream deployment backup contains a full-cluster `postgres.sql`, restore that backup only in a separate disposable PostgreSQL environment and export the individual PLANKA database before preparing the Planner capture. Planner never executes a dump or imports the deployment's PostgreSQL globals.

Create a dedicated login that can connect and select the required source columns from the restored database. The installed migration module exports the supported `sourceColumns` projection. Credentials, trust tokens and consent fields stay outside that projection. Give it `NOINHERIT`, no role memberships, no object or database ownership, and no create, temporary-object, DML, trigger, reference, maintenance or sequence write privileges. Remove inherited PUBLIC write and temporary privileges on the restored database and its schemas. Give the PostgreSQL instance a mode-0700 socket directory and mode-0700 socket under protected, nonsymlink parents. Select the restored database rather than either a maintenance database or a template.

Put the explicit service section in `/etc/planner/migration-pg.services` with root:root ownership and mode 0600. The optional `password` entry supplies a credential only when the isolated instance requires one.

```ini
[planka-frozen]
isolated=true
host=/run/planka-restore
port=55432
dbname=planka_frozen
user=planner_reader
```

After `plannerctl setup --mode import`, run preflight against this service with the materialized asset directory from prepare.

```sh
sudo plannerctl migration preflight --manifest /root/planka-capture/work/capture-ID/manifest.json \
  --source-service planka-frozen --assets-root /root/planka-capture/work/capture-ID/assets --json
```

For an object capture, replace `--assets-root` with `--asset-service NAME`. Define the service by name in `/etc/planner/migration-assets.json` with root:root ownership and mode 0600. Each service has a canonical HTTPS `base` ending in a slash, the manifest's `snapshotId`, and an optional bearer `token`. Serve the exact asset key under that prefix. Require the requested `versionId` query and return the same `X-Amz-Version-Id` on a successful response. Serve identity-encoded bytes with no redirects. A missing original blocks eligibility under the default policy, while a missing derivative is reported separately. An unexpected version, changed length, wrong checksum or ambiguous key fails preflight.

The command checks the restored catalog and migration ledger, hashes the allowlisted logical rows in a single PostgreSQL read-only snapshot, and hashes the verified file or versioned object inventory. It checks the combined capacity of any shared target volumes. It records an inactive import run and a root-only receipt in `/var/lib/planner/migration` under the native writer lease. The application briefly releases its lease for publication and resumes its previous service state. The installation still has no active imported generation. Record the run ID, manifest hash and logical fingerprint separately from the private capture and credentials. A change to the logical source snapshot requires a new run.

## Workspace storage schema

Setup and the guarded service start verify the installation identity in the dedicated MongoDB instance. A supported schema upgrade runs with the application stopped. Planner copies and verifies any legacy first-administrator grant under its generation-scoped key, creates and checks its collection indexes, and then publishes the new schema version. An interrupted upgrade resumes from the stored phase on the next operator start. The version check preserves the active generation and the setup state.

Verify the live database's owned catalog locally with `sudo plannerctl storage verify --json`. This command and the public readiness probe read the schema and indexes. An unknown version, an incomplete migration or an incompatible index keeps workspace readiness unavailable.

## HTTPS reverse proxy

The installed application reads the canonical HTTPS origin and selected port from `/etc/planner/planner.json`. It listens on the IPv4 loopback interface. The origin has the scheme, authority and optional root slash. Use the same authority, including any non-default HTTPS port, in the proxy configuration and in `plannerctl setup`.

Use the [nginx server configuration](../ops/proxy/planner-nginx.conf) with the operator-managed TLS certificate and edit the server name, authority check and forwarded authority to match the installation. For a non-default HTTPS port, also change the TLS listener and include that port in the configured authorities. The sample uses the nginx real-IP module to forward the actual connection peer address. It replaces the forwarded scheme and authority and streams board events without response buffering or compression.

nginx connects to `/run/planner-proxy/http.sock` as its unprivileged worker account. Socket mode `0666` allows the connection, and the directory grants write access to the Planner service identity. The upstream uses this socket throughout setup, restart and downtime. The separate loopback HTTP port remains available for local health checks.

After setup creates the Planner service group, provision the proxy credential as root. This command stores it in two protected files and prints no token.

```sh
sudo sh -c '
  set -eu
  umask 077
  openssl rand -hex 32 > /etc/planner/proxy-token
  chown root:planner /etc/planner/proxy-token
  chmod 0640 /etc/planner/proxy-token
  awk '\''{ printf "proxy_set_header X-Planner-Proxy-Token %s;\n", $0 }'\'' \
    /etc/planner/proxy-token > /etc/nginx/planner-proxy-auth.conf
  chmod 0600 /etc/nginx/planner-proxy-auth.conf
'
sudo plannerctl restart
sudo nginx -t
sudo systemctl reload nginx
```

Planner accepts a single address from authenticated requests on the proxy socket. It uses its configured origin for security decisions and strips forwarding headers before dispatch. Direct loopback requests have no asserted public client address. Keep the nginx credential include root-only and exclude the token from proxy logs. Restart Planner and reload nginx when rotating it.

## Runtime status and setup access

`GET /health/live` tracks the HTTP process. `GET /health/ready` returns 503 during pending setup, migration, database downtime, staging errors, schema verification or recovery. Both responses carry `status`, `version` and a generated `requestId`, with `Cache-Control: no-store`.

The native application gates workspace API requests, file metadata and bytes, event streams, ordinary sessions, consent and browser deep links before handlers run. Health and packaged assets remain available. When setup has a verified fresh enrollment grant, the boundary admits the recovery page and the exact recovery request from the configured HTTPS proxy and origin. Enrollment handlers and automatic workspace activation are implemented in later tasks.

Ask the running service for its protected status with this local command. The socket belongs to the Planner service UID with mode `0600` in its managed runtime directory. The status exposes a bounded access state and release version.

```sh
sudo curl --unix-socket /run/planner/admin.sock http://localhost/status
```

## Offline acceptance

The [native installation test](../tests/release/native-installation.sh) runs as root in a disposable Ubuntu guest with networking disabled. Attach a read-only ISO containing the signed candidate and its test public key at the root, plus the signed prior package and its test public key under `previous/`. The script takes the ISO mount path. It verifies both signatures, checks failed installs and upgrades, and then installs and reinstalls the candidate while an independently owned MongoDB sentinel runs on port `27017`.

Run the [private database acceptance test](../tests/release/native-mongodb.sh) in the same disposable guest after the native installation test passes. It exercises initialization, interruption, restart, a collision and an installation identity mismatch through the installed entry points.

Run the [operator acceptance test](../tests/release/native-setup.sh) for each setup mode in a clean offline guest. It takes the signed candidate ISO mount point and the mode. After the first phase succeeds, reboot the same guest and run it with the additional `reboot-check` argument.

Run the [HTTP and proxy acceptance test](../tests/release/native-http.sh) in a separate clean offline guest. Place the signed candidate, test public key, sample nginx configuration and `native-http-fixture.mjs` at the ISO root. Put the two nginx packages pinned by the test in `nginx/`. The test uses a guest-only event source to measure streaming through TLS.

Run the [writer ownership acceptance test](../tests/release/native-writer.sh) in a clean offline guest with the signed candidate, test public key and `release.py` at the ISO root. Place the signed pre-schema package and its test public key in `previous/`. The test exercises upgrade contention, the systemd backend's held inode, crash recovery and failed launch cleanup.

Run the [storage upgrade acceptance test](../tests/release/native-storage.sh) in a clean offline guest. Pair the signed current candidate at the root of the read-only ISO with the signed schema-0 operator build under `previous/`. The test uses the installed operator commands and the guest's authenticated Planner database.

Run the [native command journal acceptance test](../tests/release/native-journal.sh) in a clean offline guest. Place the signed candidate and its public key at the root of the read-only ISO alongside `native-journal-fixture.mjs` and `tests/support/journal-operations.mjs` under the filename `journal-operations.mjs`. The test kills the guest-only writer after its first acknowledged domain write, then starts the installed systemd backend to finish the command. It also checks that a missing outbox record blocks enrollment until the record is restored and recovery completes.

Run the [native account approval acceptance test](../tests/release/native-accounts.sh) in a clean offline guest with the signed candidate and its public key at the root of the read-only ISO. It exercises the installed CLI, the protected operator socket and the private browser proxy.

### Confirm an account change

A signed-in site administrator can request a role change, disablement, reactivation or password reset from Manage accounts. Take the displayed approval ID to the Planner host. Inspect the initiating administrator, target account and exact action, then explicitly confirm:

```sh
sudo plannerctl accounts inspect APPROVAL_ID
sudo plannerctl accounts confirm APPROVAL_ID --yes
```

Approvals expire after ten minutes and can be used once. Planner checks that both accounts and the requested action still qualify when the local operator confirms. A password reset invalidates existing credentials and prints a separate 30-minute recovery grant on the local console. Give it privately to the target account holder, who can enter it under Recover your account on the sign-in page. If delivery fails, request and confirm a new reset from the account’s current revision. Disabled accounts retain their project memberships and history.
