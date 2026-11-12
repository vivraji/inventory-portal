"""Packaged build numbering and generated documentation stay in sync without app imports."""
import importlib.util
import json
import re
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ReleaseNotesTests(unittest.TestCase):
    def test_manifest_has_current_monotonic_build_and_explicit_legacy_commits(self):
        releases=json.loads((ROOT/'static/release-notes.json').read_text())
        numbers=[r['build_number'] for r in releases if r['build_number'] is not None]
        self.assertTrue(numbers)
        self.assertEqual(numbers,list(range(numbers[0],0,-1)))
        self.assertEqual(releases[0]['build_number'],numbers[0])
        commits=[]
        for release in releases:
            date.fromisoformat(release['date'])
            self.assertTrue(release['title'])
            self.assertTrue(release['changes'])
            self.assertTrue(all(isinstance(x,str) and x.strip() for x in release['changes']))
            if release['build_number'] is None:
                self.assertRegex(release['commit'],r'^[0-9a-f]{7,40}$')
            if release['commit']:
                commits.append(release['commit'])
        self.assertEqual(len(commits),len(set(commits)))

    def test_generated_markdown_matches_manifest_and_referenced_docs_exist(self):
        spec=importlib.util.spec_from_file_location('release_renderer',ROOT/'scripts/render_release_notes.py')
        renderer=importlib.util.module_from_spec(spec);spec.loader.exec_module(renderer)
        releases=json.loads(renderer.MANIFEST.read_text())
        self.assertEqual(renderer.OUTPUT.read_text(),renderer.render(releases))
        for path in [ROOT/'README.md',ROOT/'AGENTS.md',*sorted((ROOT/'docs').glob('*.md'))]:
            for target in re.findall(r'\]\(([^)]+)\)',path.read_text()):
                if '://' in target or target.startswith('#'):
                    continue
                local=target.split('#',1)[0]
                if local:
                    self.assertTrue((path.parent/local).exists(),f'{path.name}: {target}')
