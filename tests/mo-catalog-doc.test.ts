import { describe, it, expect } from 'vitest';
import {
  CATALOG_DOC_SECTIONS,
  catalogDocSkeleton,
  parseCatalogDoc,
  renderCatalogDoc,
  mergeCatalogDoc,
  catalogDocHasContent,
  catalogStartMarker,
  catalogEndMarker,
  renderCatalogSection,
} from '../src/core/concierge/index.js';

describe('catalogDocSkeleton', () => {
  it('emits all four anchored sections + folder name in heading', () => {
    const body = catalogDocSkeleton('Morion Features');
    expect(body).toContain('# Mo Catalog — Morion Features');
    for (const id of CATALOG_DOC_SECTIONS) {
      expect(body).toContain(catalogStartMarker(id));
      expect(body).toContain(catalogEndMarker(id));
    }
  });
});

describe('parseCatalogDoc', () => {
  it('round-trips a skeleton without drift', () => {
    const original = catalogDocSkeleton('Test Folder');
    const parsed = parseCatalogDoc(original);
    const rendered = renderCatalogDoc({
      folderName: 'Test Folder',
      preamble: parsed.preamble,
      sections: parsed.sections,
      trailing: parsed.trailing,
    });
    const reparsed = parseCatalogDoc(rendered);
    expect(reparsed.sections).toEqual(parsed.sections);
  });

  it('treats body without anchors as preamble', () => {
    const parsed = parseCatalogDoc('# user-only catalog, no anchors yet');
    expect(parsed.preamble).toBe('# user-only catalog, no anchors yet');
    for (const id of CATALOG_DOC_SECTIONS) {
      expect(parsed.sections[id]).toBe('');
    }
  });

  it('preserves trailing user prose after the last anchor', () => {
    const body =
      renderCatalogSection('overview', 'Project overview') +
      '\n\nUser appendix.\n';
    const parsed = parseCatalogDoc(body);
    expect(parsed.sections.overview).toBe('Project overview');
    expect(parsed.trailing).toContain('User appendix');
  });
});

describe('mergeCatalogDoc', () => {
  it('replaces section bodies when LLM provides non-empty content', () => {
    const current = catalogDocSkeleton('F');
    const llm =
      renderCatalogSection('overview', 'Updated overview.') +
      '\n\n' +
      renderCatalogSection('clusters', '- cluster-a (5 notes) — A summary');
    const merged = mergeCatalogDoc(current, llm, 'F');
    const parsed = parseCatalogDoc(merged);
    expect(parsed.sections.overview).toBe('Updated overview.');
    expect(parsed.sections.clusters).toContain('cluster-a');
    // Other sections stay at placeholder.
    expect(parsed.sections.recent).toContain('No recent activity');
  });

  it('treats empty LLM section body as "no update"', () => {
    const current =
      renderCatalogSection('overview', 'Existing overview') +
      '\n\n' +
      renderCatalogSection('clusters', 'Existing clusters list');
    const llm =
      renderCatalogSection('overview', '') +
      '\n\n' +
      renderCatalogSection('clusters', 'New cluster list');
    const merged = mergeCatalogDoc(current, llm, 'F');
    const parsed = parseCatalogDoc(merged);
    expect(parsed.sections.overview).toBe('Existing overview');
    expect(parsed.sections.clusters).toBe('New cluster list');
  });

  it('preserves user preamble + trailing prose byte-for-byte', () => {
    const current =
      '# Custom user heading\n\nProject mission statement from user.\n\n' +
      renderCatalogSection('overview', 'old overview') +
      '\n\nUser-pinned addendum.\n';
    const llm = renderCatalogSection('overview', 'new overview');
    const merged = mergeCatalogDoc(current, llm, 'F');
    expect(merged).toContain('# Custom user heading');
    expect(merged).toContain('Project mission statement from user.');
    expect(merged).toContain('User-pinned addendum.');
    expect(merged).toContain('new overview');
    expect(merged).not.toContain('old overview');
  });
});

describe('catalogDocHasContent', () => {
  it('false for skeleton', () => {
    expect(catalogDocHasContent(catalogDocSkeleton('F'))).toBe(false);
  });
  it('true after a real section is merged', () => {
    const merged = mergeCatalogDoc(
      catalogDocSkeleton('F'),
      renderCatalogSection('overview', 'Real overview text.'),
      'F',
    );
    expect(catalogDocHasContent(merged)).toBe(true);
  });
});
