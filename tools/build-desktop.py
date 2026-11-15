"""Build the Wails 3 client into the existing installer payload layout."""
import argparse
import json
import os
import platform
import plistlib
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / 'GO/GuildSync-Frontend-Client'
OUTPUT = CLIENT / 'build/bin'


def windows_manifest(version):
    template = (CLIENT / 'build/windows/wails.exe.manifest').read_text(encoding='utf-8')
    numeric_version = version.split('-')[0].split('+')[0]
    return template.replace('{{.Name}}', 'GuildSync').replace('{{.Info.ProductVersion}}', numeric_version)


def run(*args, cwd=CLIENT, env=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--universal', action='store_true', help='Build both macOS architectures')
    parser.add_argument('--dev', action='store_true', help='Enable Wails development tools')
    parser.add_argument('--server', action='store_true', help='Build a headless HTTP server binary')
    parser.add_argument('--run', action='store_true', help='Run an already built application')
    args = parser.parse_args()
    system = platform.system()
    if args.universal and system != 'Darwin':
        parser.error('--universal requires macOS')
    if args.universal and args.server:
        parser.error('--server does not produce a macOS application bundle')
    executable = OUTPUT / ('GuildSync.exe' if system == 'Windows' else 'GuildSync')
    if args.server:
        executable = OUTPUT / ('GuildSync-server.exe' if system == 'Windows' else 'GuildSync-server')
    if args.run:
        if system == 'Darwin':
            executable = OUTPUT / 'GuildSync.app/Contents/MacOS/GuildSync'
        run(executable)
        return

    OUTPUT.mkdir(parents=True, exist_ok=True)
    # The binding scanner loads Go's embedded assets before Vite has built them.
    (CLIENT / 'frontend/dist').mkdir(parents=True, exist_ok=True)
    (CLIENT / 'frontend/dist/.gitkeep').touch()
    run('wails3', 'generate', 'bindings', '-f')
    npm = 'npm.cmd' if system == 'Windows' else 'npm'
    # Only install when dependencies are absent. Reinstalling on every build wipes
    # node_modules while a running Vite dev server holds its native binding open,
    # which fails on Windows with EPERM.
    if not (CLIENT / 'frontend/node_modules').exists():
        run(npm, 'ci', cwd=CLIENT / 'frontend')
    run(npm, 'run', 'build', cwd=CLIENT / 'frontend')

    version = (ROOT / 'VERSION').read_text(encoding='utf-8').strip().removeprefix('v')
    env = os.environ.copy()
    env['CGO_ENABLED'] = '0' if system == 'Windows' else '1'
    tags = 'dev' if args.dev else 'production'
    if args.server:
        # Server mode serves the same services over HTTP and needs no GUI stack.
        env['CGO_ENABLED'] = '0'
        tags = 'server' + (',dev' if args.dev else '')
    ldflags = '-s -w -X main.appVersion=' + version + (' -H windowsgui' if system == 'Windows' and not args.dev and not args.server else '')
    syso = CLIENT / 'wails_windows_amd64.syso'
    try:
        if system == 'Windows' and not args.server:
            info = {'fixed': {'file_version': version.split('-')[0].split('+')[0]},
                    'info': {'0000': {'ProductVersion': version, 'ProductName': 'GuildSync',
                                     'FileDescription': 'GuildSync desktop helper'}}}
            metadata = OUTPUT / 'info.json'
            metadata.write_text(json.dumps(info), encoding='utf-8')
            manifest = OUTPUT / 'GuildSync.exe.manifest'
            manifest.write_text(windows_manifest(version), encoding='utf-8')
            run('wails3', 'generate', 'syso', '-arch', 'amd64', '-icon', 'build/windows/icon.ico',
                '-manifest', manifest, '-info', metadata, '-out', syso)
            env['GOARCH'] = 'amd64'
        if system == 'Darwin':
            env['MACOSX_DEPLOYMENT_TARGET'] = '12.0'
            env['CGO_CFLAGS'] = env.get('CGO_CFLAGS', '') + ' -mmacosx-version-min=12.0'
            env['CGO_LDFLAGS'] = env.get('CGO_LDFLAGS', '') + ' -mmacosx-version-min=12.0'
        architectures = ['amd64', 'arm64'] if args.universal else [None]
        binaries = []
        for arch in architectures:
            target = executable.with_name('GuildSync-' + arch) if arch else executable
            build_env = env.copy()
            if arch:
                build_env['GOARCH'] = arch
            run('go', 'build', '-trimpath', '-buildvcs=false', '-tags', tags,
                '-ldflags', ldflags, '-o', target, '.', env=build_env)
            binaries.append(target)
        if args.universal:
            run('lipo', '-create', '-output', executable, *binaries)
            for binary in binaries:
                binary.unlink()
        if system == 'Darwin' and not args.server:
            bundle = OUTPUT / 'GuildSync.app/Contents'
            (bundle / 'MacOS').mkdir(parents=True, exist_ok=True)
            (bundle / 'Resources').mkdir(parents=True, exist_ok=True)
            shutil.copy2(executable, bundle / 'MacOS/GuildSync')
            run('wails3', 'generate', 'icons', '-input', 'build/appicon.png',
                '-macfilename', bundle / 'Resources/iconfile.icns',
                '-windowsfilename', OUTPUT / 'icon.ico')
            info = {'CFBundlePackageType': 'APPL', 'CFBundleName': 'GuildSync',
                    'CFBundleExecutable': 'GuildSync', 'CFBundleIdentifier': 'com.wails.GuildSync',
                    'CFBundleVersion': version.split('-')[0].split('+')[0],
                    'CFBundleShortVersionString': version.split('-')[0].split('+')[0],
                    'CFBundleIconFile': 'iconfile', 'LSMinimumSystemVersion': '12.0',
                    'NSHighResolutionCapable': True}
            (bundle / 'Info.plist').write_bytes(plistlib.dumps(info))
            run('xattr', '-cr', bundle.parent)
            run('codesign', '--force', '--deep', '--sign', '-', bundle.parent)
            run('codesign', '--verify', '--deep', '--strict', bundle.parent)
    finally:
        if system == 'Windows' and not args.server:
            syso.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
