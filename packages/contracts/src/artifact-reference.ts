/** New Delivery references use one location and one separate fixed revision. */
export class ArtifactReferenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const document = new RegExp(`^#/p/([^/?#]+)/documents/(${uuid})\\?revision=(${uuid})$`, 'i');
const shortDocument = new RegExp(`^document:(${uuid})@(${uuid})$`, 'i');
const fixedKnowledge = new RegExp(`^#/p/([^/?#]+)/knowledge\\?knowledgeId=${uuid}&knowledgeRevision=(${uuid})$`, 'i');
const fixedEvaluation = new RegExp(`^#/p/([^/?#]+)/evaluations/${uuid}\\?revision=(${uuid})$`, 'i');
const singleRevision = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/;

export type ArtifactReference =
  | { kind: 'document'; artifactRef: string; documentId: string; revisionId: string }
  | { kind: 'web' | 'file' | 'project'; artifactRef: string; revisionId: string };

export function parseArtifactReference(ref: string, revision: string, projectId: string, strict = true): ArtifactReference {
  const value = ref.trim(), fixed = revision.trim();
  if (!value || /\s/.test(value) || /[,;|]https?:\/\//i.test(value) ||
    (!/^https?:\/\//i.test(value) && /[;,|<>]/.test(value)))
    throw new ArtifactReferenceError('ARTIFACT_REF_AMBIGUOUS',
    'Use one artifactRef only; put PR, commit and other locations in technicalEvidence');
  const short = shortDocument.exec(value);
  let route = value;
  if (short) route = `#/p/${projectId}/documents/${short[1]}?revision=${short[2]}`;
  else if (/^document:/i.test(value)) throw new ArtifactReferenceError('ARTIFACT_DOCUMENT_REVISION_REQUIRED',
    'Use document:DOCUMENT_UUID@REVISION_UUID or #/p/PROJECT_UUID/documents/DOCUMENT_UUID?revision=REVISION_UUID');
  if (/^https?:\/\//i.test(route)) {
    let url: URL;
    try { url = new URL(route); } catch { throw new ArtifactReferenceError('ARTIFACT_REF_INVALID', 'Use one valid http(s) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
      throw new ArtifactReferenceError('ARTIFACT_REF_INVALID', 'Use an http(s) URL without credentials');
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.hash.startsWith('#/p/')) {
      if (!['/', '/app/'].includes(url.pathname) || url.search)
        throw new ArtifactReferenceError('ARTIFACT_REF_INVALID', 'Use a fixed workbench route without another path or query');
      route = url.hash;
    } else if (url.hash.startsWith('#/p/')) {
      throw new ArtifactReferenceError('ARTIFACT_REF_INVALID', 'Use the project workbench route directly for an internal artifact');
    } else {
      if (!singleRevision.test(fixed)) throw new ArtifactReferenceError('ARTIFACT_REVISION_INVALID',
        'Give one fixed web revision or commit in artifactRevision; put prose in technicalEvidence');
      return { kind: 'web', artifactRef: url.href, revisionId: fixed };
    }
  }
  const doc = document.exec(route);
  if (doc) {
    let owner: string;
    try { owner = decodeURIComponent(doc[1]!); } catch { owner = ''; }
    if (owner !== projectId) throw new ArtifactReferenceError('ARTIFACT_PROJECT_MISMATCH', 'Document route must name this project');
    if (fixed.toLowerCase() !== doc[3]!.toLowerCase()) throw new ArtifactReferenceError('ARTIFACT_REVISION_MISMATCH',
      'artifactRevision must equal the Document revision in artifactRef');
    return { kind: 'document', artifactRef: route, documentId: doc[2]!, revisionId: doc[3]! };
  }
  const internal = fixedKnowledge.exec(route) ?? fixedEvaluation.exec(route);
  if (internal) {
    let owner: string;
    try { owner = decodeURIComponent(internal[1]!); } catch { owner = ''; }
    if (owner !== projectId) throw new ArtifactReferenceError('ARTIFACT_PROJECT_MISMATCH', 'Project artifact route must name this project');
    if (fixed.toLowerCase() !== internal[2]!.toLowerCase()) throw new ArtifactReferenceError('ARTIFACT_REVISION_MISMATCH',
      'artifactRevision must equal the fixed version in artifactRef');
    return { kind: 'project', artifactRef: route, revisionId: fixed };
  }
  if (route.startsWith('#/p/')) throw new ArtifactReferenceError('ARTIFACT_REF_INVALID',
    'Use a supported fixed project artifact route with its revision');
  if (/^(?:repo|git):/i.test(route) && /[&?#]/.test(route))
    throw new ArtifactReferenceError('ARTIFACT_REF_AMBIGUOUS','Use one file reference; put other locations in technicalEvidence');
  if (/^(?:repo|git):(?:\/\/)?[a-zA-Z0-9._/@+-]+$/i.test(route)) {
    if (!singleRevision.test(fixed)) throw new ArtifactReferenceError('ARTIFACT_REVISION_INVALID',
      'Give one fixed file revision or commit in artifactRevision');
    return { kind: 'file', artifactRef: route, revisionId: fixed };
  }
  if (!strict && singleRevision.test(fixed) && !/[&?#]/.test(route) &&
    (!route.includes(':') || /^(?:artifact|fixture):[^:]+$/i.test(route)))
    return { kind: 'file', artifactRef: route, revisionId: fixed };
  throw new ArtifactReferenceError('ARTIFACT_REF_INVALID',
    'Use a fixed project Document route, one http(s) URL, or a traceable repo:/git: file reference');
}
