#!/usr/bin/env python3
"""Build or verify a native Planner release candidate."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


PACKAGE = "planner-workspace"
ARCH = "amd64"
MANIFEST = "manifest.json"
SIGNATURE = "manifest.json.sig"
PRE_DEPENDENCIES = "iproute2, mawk | gawk"
DEPENDENCIES = "systemd, passwd, libc6 (>= 2.38), libgcc-s1, libstdc++6, libcurl4t64, libssl3t64"
ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
NOTICE = re.compile(r"(?:licen[cs]es?|notice[s]?|copying|copyright|third[-_ ]party(?:[-_ ]notices?)?)(?:[._ -].*)?", re.I)
SUPPLEMENTAL_NOTICES = {
    ("abstract-logging", "2.0.1"): "https://jsumners.mit-license.org/2020",
    ("koa-compose", "4.1.0"): "https://raw.githubusercontent.com/koajs/compose/903480c36957776f8561a33a840cdd0a06ad611f/LICENSE",
}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def stdout(*args, **kwargs):
    return run(*args, stdout=subprocess.PIPE, text=True, **kwargs).stdout.strip()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def archive_dir(path):
    return path.name.removesuffix(".tar.xz").removesuffix(".tgz")


def fetch_archive(pin, cache, work, env):
    filename = pin["url"].rsplit("/", 1)[-1]
    cached = cache / filename
    archive = work / filename
    has_cache = cached.is_file()
    if has_cache:
        shutil.copyfile(cached, archive)
    else:
        run("curl", "--disable", "--fail", "--silent", "--show-error", "--location",
            "--proto", "=https", "--retry", "2", "--output", archive, pin["url"], env=env)

    if sha256(archive) != pin["sha256"]:
        raise ValueError(f"SHA-256 mismatch for {cached if has_cache else filename}")

    if not has_cache:
        with tempfile.NamedTemporaryFile(dir=cache, prefix=f".{filename}.") as download:
            shutil.copyfile(archive, download.name)
            try:
                os.link(download.name, cached)
            except FileExistsError:
                pass
    return archive


def require_ed25519(key, public=False):
    args = ["openssl", "pkey", "-in", key, "-pubout", "-outform", "DER"]
    if public:
        args.append("-pubin")
    der = run(*args, stdout=subprocess.PIPE).stdout
    if len(der) != 44 or not der.startswith(ED25519_SPKI_PREFIX):
        raise ValueError("An Ed25519 PEM key is required")


def unpack_runtimes(runtimes, cache, work, env):
    node_archive = fetch_archive(runtimes["node"]["archive"], cache, work, env)
    run("tar", "-xf", node_archive, "-C", work, env=env)
    node_dir = work / archive_dir(node_archive)

    mongo_archive = fetch_archive(runtimes["mongodb"]["archive"], cache, work, env)
    mongo_top = archive_dir(mongo_archive)
    mongo_files = ["bin/mongod", "LICENSE-Community.txt", "MPL-2", "README", "THIRD-PARTY-NOTICES"]
    run("tar", "-xf", mongo_archive, "-C", work, *(f"{mongo_top}/{name}" for name in mongo_files), env=env)
    mongo_dir = work / mongo_top
    reported = stdout(mongo_dir / "bin/mongod", "--version", env=env)
    build_info = json.loads(reported.split("Build Info: ", 1)[1])
    if build_info["version"] != runtimes["mongodb"]["version"] or build_info["gitVersion"] != runtimes["mongodb"]["gitHash"]:
        raise ValueError("Private MongoDB version or binary git hash does not match the pin")
    return node_dir, mongo_dir


def build_app(source, node_dir, versions, cache, env):
    node = node_dir / "bin/node"
    npm_cli = node_dir / "lib/node_modules/npm/bin/npm-cli.js"
    npm = (node, npm_cli)
    npm_env = {
        **env,
        "PATH": f"{node.parent}:{env['PATH']}",
        "npm_config_cache": str(cache / "npm"),
        "npm_config_globalconfig": str(cache / "global.npmrc"),
        "npm_config_userconfig": os.devnull,
        "npm_config_ignore_scripts": "true",
        "npm_config_audit": "false",
        "npm_config_fund": "false",
        "npm_config_update_notifier": "false",
    }
    if stdout(node, "--version", env=env) != f"v{versions['version']}":
        raise ValueError("Private Node version does not match the pin")
    if stdout(*npm, "--version", env=npm_env) != versions["npmVersion"]:
        raise ValueError("Bundled npm version does not match the pin")
    if read_json(source / "package.json")["packageManager"] != f"npm@{versions['npmVersion']}":
        raise ValueError("Workspace and package builder require different npm versions")
    run(*npm, "ci", "--strict-peer-deps", "--include=dev", cwd=source, env=npm_env)
    run(*npm, "run", "typecheck", cwd=source, env=npm_env)
    run(*npm, "run", "build", cwd=source, env=npm_env)
    run(*npm, "ci", "--strict-peer-deps", "--omit=dev", cwd=source, env=npm_env)
    run(*npm, "ls", "--omit=dev", "--all", cwd=source, env=npm_env, stdout=subprocess.DEVNULL)


def stage_npm_inventory(release, workspaces, lock, supplemental_notices):
    inventory = []

    def visit_modules(modules):
        if not modules.is_dir():
            return
        for entry in sorted(modules.iterdir()):
            if entry.name.startswith("."):
                continue
            for package in sorted(entry.iterdir()) if entry.name.startswith("@") else [entry]:
                location = package.relative_to(release).as_posix()
                if package.is_symlink():
                    if lock[location].get("link") and package.resolve() in workspaces:
                        continue
                    raise ValueError(f"Unexpected npm package link at {location}")

                entry_lock = lock[location]
                metadata = read_json(package / "package.json")
                if metadata["version"] != entry_lock["version"] or entry_lock.get("dev"):
                    raise ValueError(f"Unexpected production dependency at {location}")
                name, version = metadata["name"], metadata["version"]
                notice_source = SUPPLEMENTAL_NOTICES.get((name, version))
                if notice_source:
                    shutil.copyfile(supplemental_notices / f"{name}-{version}.txt", package / "LICENSE.planner")
                notices = [
                    path.relative_to(release).as_posix()
                    for path in sorted(package.iterdir())
                    if NOTICE.fullmatch(path.name)
                    or (path.is_file() and path.name.lower().startswith("readme")
                        and "The above copyright notice and this permission notice" in path.read_text(
                            encoding="utf-8", errors="replace"
                        ))
                ]
                if not notices:
                    raise ValueError(f"No license notice found for {name}@{version} at {location}")
                inventory.append({
                    "path": location,
                    "name": name,
                    "version": version,
                    "license": metadata.get("license", metadata.get("licenses")),
                    "noticePaths": notices,
                    **({"supplementalNoticeSource": notice_source} if notice_source else {}),
                    "resolved": entry_lock["resolved"],
                    "integrity": entry_lock["integrity"],
                })
                visit_modules(package / "node_modules")

    visit_modules(release / "node_modules")
    for workspace in workspaces:
        visit_modules(workspace / "node_modules")
    return sorted(inventory, key=lambda dependency: dependency["path"])


def stage_package(root, source, node_dir, mongo_dir, version, runtimes, provenance):
    release = root / "opt/planner/releases" / version
    doc = root / "usr/share/doc" / PACKAGE
    release.mkdir(parents=True)
    doc.mkdir(parents=True)
    shutil.copyfile(source / "LICENSE", doc / "copyright")
    shutil.copyfile(source / "package-lock.json", release / "package-lock.json")
    package_json = read_json(source / "package.json")
    write_json(release / "package.json", {
        "name": package_json["name"], "version": version, "private": True,
        "workspaces": package_json["workspaces"], "type": package_json["type"],
    })
    workspaces = [release / workspace for workspace in package_json["workspaces"]]

    for path in [release, *workspaces]:
        origin = source / path.relative_to(release)
        if path != release:
            path.mkdir(parents=True)
            shutil.copyfile(origin / "package.json", path / "package.json")
            shutil.copytree(origin / "dist", path / "dist")
        if (origin / "node_modules").is_dir():
            shutil.copytree(origin / "node_modules", path / "node_modules", symlinks=True,
                            ignore=shutil.ignore_patterns(".package-lock.json"))

    for runtime, executable in (("node", node_dir / "bin/node"), ("mongodb", mongo_dir / "bin/mongod")):
        destination = release / "runtime" / runtime / "bin" / executable.name
        destination.parent.mkdir(parents=True)
        shutil.copyfile(executable, destination)
        destination.chmod(0o755)
        (doc / runtime).mkdir()
    shutil.copyfile(node_dir / "LICENSE", doc / "node/LICENSE")
    for name in ("LICENSE-Community.txt", "MPL-2", "README", "THIRD-PARTY-NOTICES"):
        shutil.copyfile(mongo_dir / name, doc / "mongodb" / name)
    (release / "apps/frontend/dist/.vite/license.md").rename(doc / "frontend-bundle-licenses.md")

    lock = read_json(source / "package-lock.json")["packages"]
    inventory = stage_npm_inventory(release, workspaces, lock, source / "ops/package/notices")
    write_json(doc / "dependencies.json", {
        "debianDepends": DEPENDENCIES,
        "debianPreDepends": PRE_DEPENDENCIES,
        "npmProduction": inventory,
        "frontendBundleLicenses": "frontend-bundle-licenses.md",
        "runtimeNotices": {"node": "node/LICENSE", "mongodb": "mongodb/"},
    })
    write_json(doc / "provenance.json", {**provenance, "runtimes": runtimes})
    (release / "bin").mkdir()
    launcher = release / "bin/plannerctl"
    shutil.copyfile(source / "ops/package/plannerctl", launcher)
    launcher.chmod(0o755)
    (root / "opt/planner/current").symlink_to(f"releases/{version}")
    (root / "usr/bin").mkdir()
    (root / "usr/bin/plannerctl").symlink_to("../../opt/planner/current/bin/plannerctl")

    control = root / "DEBIAN"
    control.mkdir()
    native = source / "ops/package/native-preflight"
    (release / "lib").mkdir()
    for destination in (control / "preinst", release / "lib/native-preflight"):
        shutil.copyfile(native, destination)
        destination.chmod(0o755)
    shutil.copyfile(source / "ops/package/postinst", control / "postinst")
    (control / "postinst").chmod(0o755)
    for path in ("usr/lib/systemd/system", "usr/lib/tmpfiles.d"):
        (root / path).mkdir(parents=True, exist_ok=True)
    for unit in ("planner.service", "planner-mongodb.service"):
        destination = root / "usr/lib/systemd/system" / unit
        shutil.copyfile(source / "ops/systemd" / unit, destination)
        destination.chmod(0o644)
    tmpfiles = root / "usr/lib/tmpfiles.d/planner-workspace.conf"
    shutil.copyfile(source / "ops/systemd/planner-workspace.conf", tmpfiles)
    tmpfiles.chmod(0o644)
    (control / "control").write_text(
        f"Package: {PACKAGE}\nVersion: {version}\nArchitecture: {ARCH}\n"
        "Maintainer: Planner <topchiyev@gmail.com>\n"
        f"Section: web\nPriority: optional\nPre-Depends: {PRE_DEPENDENCIES}\nDepends: {DEPENDENCIES}\n"
        "Description: Planner workspace application with private runtimes\n",
        encoding="utf-8",
    )


def build(output, key, revision, cache):
    host = Path("/etc/os-release").read_text().splitlines()
    if "ID=ubuntu" not in host or 'VERSION_ID="24.04"' not in host or os.uname().machine != "x86_64":
        raise ValueError("Build on Ubuntu 24.04 amd64")
    if output.exists():
        raise ValueError(f"Output directory already exists: {output}")
    require_ed25519(key)
    cache.mkdir(parents=True, exist_ok=True)
    env = {
        **{name: value for name, value in os.environ.items()
           if not name.lower().startswith(("npm_config_", "node_", "dpkg_deb_", "xz_"))
           and name not in ("TAR_OPTIONS", "GZIP")},
        "PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8", "TZ": "UTC",
        "RAYON_NUM_THREADS": "2", "UV_THREADPOOL_SIZE": "2",
    }

    with tempfile.TemporaryDirectory(prefix=".planner-build-", dir=output.parent) as temp:
        work = Path(temp)
        source = work / "source"
        source.mkdir()
        git = ("git", "-C", Path(__file__).resolve().parents[2])
        commit = stdout(*git, "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}")
        epoch = stdout(*git, "show", "-s", "--format=%ct", commit)
        env["SOURCE_DATE_EPOCH"] = epoch
        source_tar = work / "source.tar"
        run(*git, "-c", "tar.umask=0022", "archive", "--format=tar", "--output", source_tar, commit, env=env)
        run("tar", "-xf", source_tar, "-C", source, env=env)
        committed_builder = source / "ops/package/release.py"
        if committed_builder.read_bytes() != Path(__file__).read_bytes():
            raise ValueError("Run the release builder committed in the selected revision")

        runtimes = read_json(source / "ops/package/runtimes.json")
        version = read_json(source / "package.json")["version"]
        if not VERSION.fullmatch(version):
            raise ValueError(f"Invalid Planner release version: {version}")
        provenance = {
            "plannerSource": {"gitCommit": commit, "gitArchiveSha256": sha256(source_tar)},
            "sourceDateEpoch": int(epoch),
            "packageLockSha256": sha256(source / "package-lock.json"),
        }
        node_dir, mongo_dir = unpack_runtimes(runtimes, cache, work, env)
        build_app(source, node_dir, runtimes["node"], work / "build-cache", env)
        root = work / "root"
        stage_package(root, source, node_dir, mongo_dir, version, runtimes, provenance)
        for path in [root, *root.rglob("*")]:
            os.utime(path, (int(epoch), int(epoch)), follow_symlinks=False)

        artifacts = work / "artifacts"
        artifacts.mkdir()
        package = artifacts / f"{PACKAGE}_{version}_{ARCH}.deb"
        run("dpkg-deb", "--root-owner-group", "--threads-max=2", "-Zzstd", "-z10",
            "--build", root, package, env=env)
        write_json(artifacts / MANIFEST, {
            "formatVersion": 1,
            "package": {
                "name": PACKAGE, "version": version, "architecture": ARCH, "filename": package.name,
                "sha256": sha256(package), "size": package.stat().st_size,
            },
            "runtimes": runtimes,
            **provenance,
        })
        run("openssl", "pkeyutl", "-sign", "-rawin", "-inkey", key,
            "-in", artifacts / MANIFEST, "-out", artifacts / SIGNATURE)
        run("mv", "--no-clobber", "--no-target-directory", artifacts, output)
        if artifacts.exists():
            raise ValueError(f"Output directory already exists: {output}")
    print(output)


def verify(artifacts, key):
    require_ed25519(key, public=True)
    manifest = artifacts / MANIFEST
    manifest_bytes = manifest.read_bytes()
    # Verify and parse the same bytes. OpenSSL needs a seekable input for Ed25519.
    with tempfile.NamedTemporaryFile() as signed:
        signed.write(manifest_bytes)
        signed.flush()
        run("openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", key,
            "-sigfile", artifacts / SIGNATURE, "-in", signed.name, stdout=subprocess.DEVNULL)
    metadata = json.loads(manifest_bytes)
    package = metadata["package"]
    version = package["version"]
    filename = f"{PACKAGE}_{version}_{ARCH}.deb"
    if (metadata["formatVersion"] != 1 or package["name"] != PACKAGE or package["architecture"] != ARCH
            or not VERSION.fullmatch(version) or package["filename"] != filename):
        raise ValueError("Unsupported release manifest")
    artifact = artifacts / filename
    if artifact.stat().st_size != package["size"] or sha256(artifact) != package["sha256"]:
        raise ValueError(f"Package checksum or size mismatch: {filename}")
    print(f"Verified signature and package checksum for {filename}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    builder = commands.add_parser("build", help="build and sign a candidate from a Git commit")
    verifier = commands.add_parser("verify", help="verify a candidate with a trusted public key")
    for command in (builder, verifier):
        command.add_argument("artifacts", type=Path)
        command.add_argument("key", type=Path, help="Ed25519 private key for build or public key for verify")
    builder.add_argument("--revision", default="HEAD")
    builder.add_argument("--cache", type=Path, default=Path("~/.cache/planner/vendor").expanduser())
    args = parser.parse_args()
    os.umask(0o022)
    try:
        if args.command == "build":
            build(args.artifacts.absolute(), args.key.resolve(strict=True), args.revision, args.cache.resolve())
        else:
            verify(args.artifacts, args.key)
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Planner release: {error}\n")


if __name__ == "__main__":
    main()
