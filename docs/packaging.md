# Build the native Planner package

Build on Ubuntu 24.04 amd64 as an ordinary user. The host needs Git, Python 3, OpenSSL, curl, GNU tar with xz and gzip, and `dpkg-deb`. MongoDB 8.0 requires an AVX-capable processor. Downloads use the release archives pinned in the repository and the npm registry entries from the workspace lockfile. [MongoDB production notes](https://www.mongodb.com/docs/v8.0/administration/production-notes/)

From the repository root, build and verify an internal candidate with a disposable signing key.

```sh
package_work=$(mktemp -d)
openssl genpkey -algorithm ED25519 -out "$package_work/test-key.pem"
openssl pkey -in "$package_work/test-key.pem" -pubout -out "$package_work/test-key.pub.pem"

python3 ops/package/release.py build "$package_work/first" "$package_work/test-key.pem" \
  --cache "$package_work/vendor"
python3 ops/package/release.py verify "$package_work/first" "$package_work/test-key.pub.pem"
```

The builder exports the selected Git commit into a clean directory, defaults to `HEAD`, and accepts `--revision <ref>`. Run the builder from the selected version of the repository. The output parent must exist and the candidate directory must be new. Each run verifies cached vendor archives before extracting them, uses each run's own npm cache, typechecks and compiles with the pinned Node and npm, then stages the production npm dependency tree with the workspace links intact. It normalizes package timestamps to the selected commit's committer timestamp and records package ownership as `root:root`.

The candidate contains `planner-workspace_0.1.0_amd64.deb`, `manifest.json`, and `manifest.json.sig`. The Debian package ID `planner-workspace` lets the application coexist with Ubuntu's GNOME Planner package. The manifest uses sorted keys, two-space indentation and a final newline. The detached signature covers those exact bytes. The verifier takes a trusted Ed25519 public key and checks both the manifest signature and the named package's SHA-256 and size.

To repeat the build on the same host and compare the results, use the same commit, host packaging tools and key. Each run gets a clean application build and staging directory.

```sh
python3 ops/package/release.py build "$package_work/second" "$package_work/test-key.pem" \
  --cache "$package_work/vendor"
for artifact in planner-workspace_0.1.0_amd64.deb manifest.json manifest.json.sig; do
  cmp "$package_work/first/$artifact" "$package_work/second/$artifact" || exit 1
done
```

## Extract and check the candidate

The package stages the release files and entry points. Service installation, configuration and persistent storage are covered by the subsequent native installer tasks.

| Installed path | Contents |
| --- | --- |
| `/opt/planner/releases/0.1.0` | Compiled backend, frontend, contracts and CLI, workspace metadata and production npm packages |
| `/opt/planner/releases/0.1.0/runtime/node/bin/node` | Private Node.js 24.22.3 |
| `/opt/planner/releases/0.1.0/runtime/mongodb/bin/mongod` | Private MongoDB 8.0.38 Community Server |
| `/opt/planner/current` | Relative symlink to `releases/0.1.0` |
| `/usr/bin/plannerctl` | Link to the current release launcher, which invokes the release's private Node |
| `/usr/share/doc/planner-workspace` | Planner copyright, vendor notices, frontend bundle licenses, actual production npm inventory and source provenance |

```sh
package="$package_work/first/planner-workspace_0.1.0_amd64.deb"
dpkg-deb --info "$package"
dpkg-deb --contents "$package" > "$package_work/contents.txt"
dpkg-deb --extract "$package" "$package_work/extracted"
release="$package_work/extracted/opt/planner/current"

"$release/runtime/node/bin/node" --version
"$release/runtime/mongodb/bin/mongod" --version
"$package_work/extracted/usr/bin/plannerctl" --version
PLANNER_HTTP_PORT=0 "$release/runtime/node/bin/node" "$release/apps/backend/dist/main.js"
```

The backend prints an ephemeral loopback address. Use that address to check `/health/live` for HTTP 200, `/health/ready` for the current unconfigured HTTP 503 response, and `/boards/b/cards/c?context=archive` for the compiled frontend shell. Check the JavaScript and CSS URLs referenced in that response. Stop the process with Ctrl-C.

The package's `Depends` field lists the host libraries used by the bundled executables. The license inventory records each installed npm production package's lockfile source, integrity, declared license and packaged notice files. It identifies the source of the supplemental license text for `abstract-logging` and `koa-compose`. Vite generates a separate license list from the dependencies used in the compiled frontend. [Vite build license option](https://vite.dev/config/build-options.html#build-license)

## Runtime provenance and distribution

The committed pins and generated manifests record the vendor archive checksums, upstream signature locations and signer fingerprints, and source archive checksums. The package includes the full Node license and MongoDB's Community license, MPL notice, third-party notices and README. [Runtime pins](../ops/package/runtimes.json)

MongoDB's bundled binary reports git hash `b2f7afe3a6838999fd375c7a7ea678189f795568`. The exact public corresponding source is tag `r8.0.38` at commit `11d6674e73e4b36060314e68d7a12656d6a12aab`. The SHA-256 of that source archive is `d24d9b3489172c758690aaced8a7a56afad43e3b62cccbe585a8565818f0059e`. [Exact MongoDB source archive](https://codeload.github.com/mongodb/mongo/tar.gz/11d6674e73e4b36060314e68d7a12656d6a12aab)

For distribution, verify the release manifest, make the exact corresponding source available with the binary under the applicable license terms, and include the notices. The package and signed manifest identify the source archive by URL and checksum. [MongoDB license](https://www.mongodb.com/legal/licensing/server-side-public-license)
