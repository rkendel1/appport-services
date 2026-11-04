// An internal example management extension: notes per tenant. It exists to prove the extension
// contract (tests/extensions.test.ts and the browser suite); it is not part of the package.
// Everything it does goes through what the host gives it: the host's FeltDB instance, and the
// host's gateway with the two capabilities it declares.
import { json, type Request } from 'express';
import { defineServicesExtension, type ServicesExtension, type VerifiedPrincipal } from '../../src/index.js';

export const NOTES_COLLECTION = 'ext_notes';

interface Note { id: string; tenantId: string; text: string; createdBy: string; createdAt: string }

const principalOf = (req: Request): VerifiedPrincipal => {
  const principal = req.auth as VerifiedPrincipal | undefined;
  if (!principal) throw Object.assign(new Error('Authentication is required'), { status: 401, code: 'UNAUTHENTICATED' });
  return principal;
};

/** The renderer: registers itself, then draws with the host's helpers into the host's shell. */
const SCRIPT = `
window.AppPortServicesPages = window.AppPortServicesPages || {};
window.AppPortServicesPages['notes'] = function (ui) {
  var list = ui.el('ul', { 'data-notes': '' });
  var input = ui.el('input', { name: 'text', 'aria-label': 'Note' });
  var status = ui.el('p', { 'data-status': '' });
  function draw(notes) {
    list.replaceChildren.apply(list, notes.map(function (n) { var li = document.createElement('li'); li.textContent = n.text; return li; }));
  }
  function load() { return ui.request('/v1/extensions/notes').then(function (b) { draw(b.notes); }, function (e) { status.textContent = e.message; }); }
  var form = ui.el('form', {}, [input, ui.el('button', { type: 'submit' }, 'Add note')]);
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    ui.request('/v1/extensions/notes', 'POST', { text: input.value }).then(function () { input.value = ''; return load(); }, function (e) { status.textContent = e.message; });
  });
  load();
  return ui.el('section', { 'data-extension-page': 'notes' }, [ui.el('h1', {}, 'Notes'), form, status, list]);
};
`;

export const notesExtension: ServicesExtension = defineServicesExtension({
  id: 'notes',
  capabilities: [
    { name: 'notes.read', operation: 'listNotes', effect: 'observation', resource: 'note' },
    { name: 'notes.write', operation: 'createNote', effect: 'consequential', resource: 'note' },
  ],
  pages: [
    { id: 'notes', title: 'Notes', route: '/notes', order: 90, description: 'Notes for this tenant (an example extension).', capabilities: ['notes.read', 'notes.write'], script: SCRIPT },
  ],
  routes(router, { db, gateway }) {
    router.use(json());
    router.get('/', async (req, res, next) => {
      try {
        const principal = principalOf(req);
        const notes = await gateway.execute('notes.read', principal, { type: 'note', tenantId: principal.tenantId }, { service: 'notes' },
          async () => db.collection<Note>(NOTES_COLLECTION).find({ tenantId: principal.tenantId }));
        res.json({ notes });
      } catch (error) { next(error); }
    });
    router.post('/', async (req, res, next) => {
      try {
        const principal = principalOf(req);
        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text) { res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'text is required' } }); return; }
        const note = await gateway.execute('notes.write', principal, { type: 'note', tenantId: principal.tenantId }, { service: 'notes' }, async () => {
          const record: Note = { id: crypto.randomUUID(), tenantId: principal.tenantId, text, createdBy: principal.principalId, createdAt: new Date().toISOString() };
          await db.collection<Note>(NOTES_COLLECTION).insert(record as never, record.id);
          return record;
        });
        res.status(201).json({ note });
      } catch (error) { next(error); }
    });
  },
});
