"""Verify the manifest passed to Wails 3 is usable Windows assembly metadata."""
import importlib.util
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

spec = importlib.util.spec_from_file_location('desktop_build', Path(__file__).with_name('build-desktop.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class WindowsManifestTests(unittest.TestCase):
    def test_release_and_prerelease_have_numeric_assembly_versions(self):
        for version in ['1.5.2', '1.5.3-beta.1+build.2', '1.5.3+build.2']:
            with self.subTest(version=version):
                manifest = build.windows_manifest(version)
                identity = ET.fromstring(manifest).find('{urn:schemas-microsoft-com:asm.v1}assemblyIdentity')
                self.assertEqual(identity.attrib['name'], 'com.wails.GuildSync')
                self.assertEqual(identity.attrib['version'], version.split('-')[0].split('+')[0] + '.0')
                self.assertNotIn('{{', manifest)


if __name__ == '__main__':
    unittest.main()
