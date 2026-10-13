// AppPort Services management pages, rendered with the shared Stack design
// system (vendor/stack-ui's stateless build, loaded before this script as
// `window.StackUI`). The pages store nothing in the browser: there is no theme
// control, and the colour scheme follows the operating system.
//
// The server sends one page description (`#appport-page`: which page, and the
// navigation built from the surfaces actually mounted); this script renders the
// shell and the page with StackUI's DOM helpers. It builds nodes with
// createElement and textContent only: it never parses markup. Every request
// goes to the routes these pages have always used; nothing new is called.
'use strict';
(function () {
  const S = window.StackUI;
  const config = JSON.parse(document.getElementById('appport-page').textContent);

  // ---- Requests -------------------------------------------------------------

  /// Sends a request and returns its JSON body (null for 204). A failure keeps
  /// the product's message and code; a request that never got an answer says the
  /// outcome is unknown rather than guessing it failed.
  async function request(path, method, body) {
    let response;
    try {
      response = await fetch(path, {
        method: method || 'GET',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      const error = new Error('Result unknown — check current state. The request did not get an answer.');
      error.code = 'NO_RESPONSE';
      throw error;
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload && payload.error;
      const error = new Error(typeof detail === 'string' ? detail
        : (detail && detail.message) || 'The request failed with status ' + response.status + '.');
      error.code = (detail && typeof detail === 'object' && detail.code) || (payload && payload.code) || 'HTTP_' + response.status;
      throw error;
    }
    return payload;
  }
  const failureOf = (error) => ({ message: error.message, code: error.code });

  // ---- Small builders --------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of [].concat(children === undefined ? [] : children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
    return node;
  }

  /// A timestamp as the design system shows them, or undefined (shown as —).
  const when = (value) => (value ? el('time', { datetime: value }, S.formatTime(value)) : undefined);
  const text = (value) => (value === null || value === undefined || value === '' ? undefined : String(value));

  /// Where a section reports what happened: a polite status line for success,
  /// the shared ErrorPanel for a failure.
  function outcome() {
    // The status line is always in the page, so a change to its text is
    // announced; it takes focus after a dialog whose trigger the refreshed list
    // replaced, so keyboard users are not left on the page body.
    const status = el('p', { class: 'appport-outcome__ok', role: 'status', tabindex: '-1' });
    const problem = el('div', { class: 'appport-outcome__problem' });
    const node = el('div', { class: 'appport-outcome' }, [status, problem]);
    return {
      node,
      ok(message, detail, focus) {
        problem.replaceChildren();
        status.replaceChildren(message, ...(detail ? [detail] : []));
        if (focus) status.focus();
      },
      fail(error, title, onRetry) {
        status.replaceChildren();
        problem.replaceChildren(S.dom.ErrorPanel({ title: title || 'Not done', ...failureOf(error), ...(onRetry ? { onRetry } : {}) }));
      },
      clear() { status.replaceChildren(); problem.replaceChildren(); },
      clearProblem() { problem.replaceChildren(); },
    };
  }

  /// Some routes answer 200 with `null` when the record was not found or
  /// changed meanwhile: that is not a success.
  const changed = (result, what) => {
    if (result !== null) return result;
    const error = new Error(what + ' was not found or has changed. Check the current state below.');
    error.code = 'NOT_CHANGED';
    throw error;
  };

  /// A list read from the product and shown as a DataTable: loading first, then
  /// rows, an empty state, or the error with Retry (reads are safe to retry).
  function list(options) {
    const node = el('div', { class: 'appport-list' });
    let rows = [];
    let latest = 0;
    const draw = (state) => node.replaceChildren(S.dom.DataTable({
      label: options.label,
      columns: options.columns,
      rows,
      emptyTitle: options.empty,
      emptyBody: options.emptyBody,
      ...state,
    }));
    async function refresh() {
      // Only the newest read may draw: an older one finishing late must not
      // replace a newer list.
      const mine = ++latest;
      draw({ loading: true, loadingWhat: options.label.toLowerCase() });
      try {
        const items = await options.read();
        if (mine !== latest) return;
        rows = items.map(options.row);
        draw({});
      } catch (error) {
        if (mine !== latest) return;
        rows = [];
        draw({ error: { title: options.label + ' could not be read', ...failureOf(error), onRetry: refresh } });
      }
    }
    return { node, refresh };
  }

  /// A create form: labelled fields, a busy submit while the request runs, the
  /// product's answer reported beside it, and the list refreshed after success.
  function createForm(options) {
    const report = outcome();
    const form = S.dom.Form({
      id: options.id,
      label: options.label,
      submitLabel: options.submitLabel,
      // Field ids are prefixed by the form's, so two forms on one page never share one.
      children: options.fields.map((field) => {
        const props = { id: options.id + '-' + field.name, ...field };
        return field.options ? S.dom.Select(props) : S.dom.TextField(props);
      }),
      onSubmit: async (event) => {
        const target = event.target;
        const submit = target.querySelector('button[type="submit"]');
        let body;
        try {
          body = options.body(Object.fromEntries(new FormData(target)));
        } catch (error) {
          report.fail(error, 'Check the form');
          return;
        }
        submit.disabled = true;
        submit.setAttribute('aria-busy', 'true');
        target.setAttribute('aria-busy', 'true');
        report.clear();
        try {
          const created = await options.send(body);
          target.reset();
          report.ok(...[].concat(options.done(created)));
          if (options.after) await options.after();
        } catch (error) {
          report.fail(error);
        } finally {
          submit.disabled = false;
          submit.removeAttribute('aria-busy');
          target.removeAttribute('aria-busy');
        }
      },
    });
    return el('div', { class: 'appport-create' }, [form, report.node]);
  }

  /// A row action button whose accessible name says which row it acts on.
  const action = (label, target, onClick, variant) => S.dom.Button({
    label, size: 'sm', variant: variant || 'ghost', onClick, attrs: { 'aria-label': label + ' ' + target },
  });

  /// Runs a destructive action through ConfirmAction, then reports and refreshes.
  async function confirmThen(props, report, refresh) {
    const done = await S.confirmAction(props);
    if (done) {
      report.ok(props.doneMessage, null, true);
      await refresh();
    }
  }

  const NAME_FIELD = { pattern: '[A-Z][A-Z0-9_]*', hint: 'Capital letters, digits and underscores, starting with a letter.' };
  const CREDENTIAL_HINT = 'A reference held in AuthBoundry custody: credential-ref:<id>. The secret itself never passes through these pages.';

  // ---- Pages -----------------------------------------------------------------

  const PAGES = {
    overview() {
      const links = config.navigation.filter((item) => item.id !== 'overview');
      return [
        S.dom.PageHeader({ title: 'AppPort Services', description: 'Durable application infrastructure backed by FeltDB.' }),
        links.length
          ? el('ul', { class: 'appport-services' }, links.map((item) => el('li', { class: 'appport-service' }, [
            el('h2', { class: 'appport-service__title' }, el('a', { href: item.route }, item.label)),
            el('p', { class: 'appport-service__body' }, config.descriptions[item.id] || ''),
          ])))
          : S.dom.EmptyState({ title: 'No services are mounted', body: 'This host serves no management pages.' }),
      ];
    },

    'api-keys'() {
      const report = outcome();
      const keys = list({
        label: 'API keys',
        empty: 'No API keys yet',
        columns: [
          { id: 'name', header: 'Name' }, { id: 'prefix', header: 'Prefix' }, { id: 'created', header: 'Created' },
          { id: 'state', header: 'State' }, { id: 'actions', header: 'Actions' },
        ],
        read: () => request('/_appport/api/keys'),
        row: (key) => ({
          key: key.id,
          attrs: { 'data-key': key.name },
          cells: {
            name: text(key.name),
            prefix: key.keyPrefix ? el('code', {}, key.keyPrefix) : undefined,
            created: when(key.createdAt),
            // The management route lists active keys only (revoked ones are
            // filtered out), so this reads Active; it is still read from the record.
            state: S.dom.StatusIndicator({ field: 'appport.api_key.revoked', value: Boolean(key.revokedAt) }),
            actions: key.revokedAt ? [] : action('Revoke', key.name, () => confirmThen({
              id: 'revoke-key',
              title: 'Revoke API key ' + key.name + '?',
              consequences: ['Requests that present this key are refused from then on.', 'A revoked key cannot be restored. Create a new key to replace it.'],
              confirmLabel: 'Revoke API key',
              requireText: key.name,
              action: () => request('/_appport/api/keys/' + encodeURIComponent(key.id), 'DELETE'),
              doneMessage: 'Revoked ' + key.name + '. Revoked keys are not listed.',
            }, report, keys.refresh), 'danger'),
          },
        }),
      });
      keys.refresh();
      return [
        S.dom.PageHeader({ title: 'API Keys', description: 'Create durable caller identities. The secret is returned only when the record is created. Keys carry no scopes: AuthBoundry authorizes each capability.' }),
        createForm({
          id: 'create-api-key', label: 'Create API key', submitLabel: 'Create API key',
          fields: [{ name: 'name', label: 'Key name', required: true }],
          body: (values) => ({ name: values.name }),
          send: (body) => request('/_appport/api/keys', 'POST', body),
          // The product returns the secret once; show it once, plainly.
          done: (created) => (created && created.secret
            ? ['Created. Copy this secret now; it is not shown again: ', el('code', { class: 'appport-secret' }, created.secret)]
            : 'API key created.'),
          after: keys.refresh,
        }),
        report.node,
        keys.node,
      ];
    },

    jobs() {
      const report = outcome();
      const jobs = list({
        label: 'Jobs',
        empty: 'No jobs yet',
        columns: [
          { id: 'type', header: 'Type' }, { id: 'status', header: 'Status' }, { id: 'attempts', header: 'Attempts', align: 'end' },
          { id: 'run', header: 'Run at' }, { id: 'error', header: 'Last error' }, { id: 'actions', header: 'Actions' },
        ],
        read: () => request('/_appport/jobs'),
        row: (job) => ({
          key: job.id,
          attrs: { 'data-job': job.type },
          cells: {
            type: text(job.type),
            status: S.dom.StatusIndicator({ field: 'appport.job.status', value: job.status }),
            attempts: job.attemptCount + ' / ' + job.maxAttempts,
            run: when(job.runAt),
            error: text(job.lastError),
            actions: job.status === 'failed' || job.status === 'completed'
              ? action('Retry', job.type, async () => {
                try {
                  changed(await request('/_appport/jobs/' + encodeURIComponent(job.id) + '/retry', 'POST'), 'The ' + job.type + ' job');
                  report.ok('Queued ' + job.type + ' again.');
                  await jobs.refresh();
                } catch (error) { report.fail(error, 'Not retried'); }
              })
              : [],
          },
        }),
      });
      jobs.refresh();
      return [
        S.dom.PageHeader({ title: 'Jobs', description: 'Queue durable work for execution by a worker.' }),
        createForm({
          id: 'queue-job', label: 'Queue job', submitLabel: 'Queue job',
          fields: [
            { name: 'type', label: 'Job type', required: true, placeholder: 'invoice.process' },
            { name: 'payload', label: 'Payload JSON', multiline: true, rows: 3, value: '{}', hint: 'A JSON object passed to the worker as is.' },
          ],
          body: (values) => {
            let payload;
            try { payload = JSON.parse(values.payload || '{}'); } catch { throw new Error('The payload is not valid JSON.'); }
            // The product accepts an object only; say so before sending.
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The payload must be a JSON object, like {"invoice": 7}.');
            return { type: values.type, payload };
          },
          send: (body) => request('/_appport/jobs', 'POST', body),
          done: () => 'Job queued.',
          after: jobs.refresh,
        }),
        report.node,
        jobs.node,
      ];
    },

    schedules() {
      const words = { s: 'second', m: 'minute', h: 'hour', d: 'day' };
      const english = (value) => {
        const match = String(value).match(/^(\d+)([smhd])$/);
        return match ? 'Every ' + match[1] + ' ' + words[match[2]] + (match[1] === '1' ? '' : 's') : String(value);
      };
      const report = outcome();
      const schedules = list({
        label: 'Schedules',
        empty: 'No schedules yet',
        columns: [
          { id: 'type', header: 'Type' }, { id: 'frequency', header: 'Frequency' }, { id: 'next', header: 'Next run' },
          { id: 'by', header: 'Created by' }, { id: 'status', header: 'Status' }, { id: 'actions', header: 'Actions' },
        ],
        read: () => request('/_appport/schedules'),
        row: (schedule) => ({
          key: schedule.id,
          attrs: { 'data-schedule': schedule.type },
          cells: {
            type: text(schedule.type),
            frequency: english(schedule.interval),
            next: when(schedule.nextRunAt),
            by: text(schedule.createdBy),
            status: S.dom.StatusIndicator({ field: 'appport.schedule.enabled', value: Boolean(schedule.enabled) }),
            actions: schedule.enabled ? action('Disable', schedule.type, () => confirmThen({
              id: 'disable-schedule',
              title: 'Disable the ' + schedule.type + ' schedule?',
              consequences: ['No further ' + schedule.type + ' jobs are queued from this schedule.', 'Jobs already queued are not affected.', 'AppPort Services has no operation to enable it again; create a new schedule instead.'],
              confirmLabel: 'Disable schedule',
              action: async () => changed(await request('/_appport/schedules/' + encodeURIComponent(schedule.id), 'DELETE'), 'The schedule'),
              doneMessage: 'Disabled the ' + schedule.type + ' schedule.',
            }, report, schedules.refresh), 'danger') : [],
          },
        }),
      });
      schedules.refresh();
      return [
        S.dom.PageHeader({ title: 'Schedules', description: 'Create recurring execution definitions using plain English. Each one is stored durably in FeltDB.' }),
        createForm({
          id: 'create-schedule', label: 'Create schedule', submitLabel: 'Create schedule',
          fields: [
            { name: 'type', label: 'Job type', required: true, placeholder: 'invoice.process' },
            { name: 'interval', label: 'Frequency', value: '15m', options: [
              { value: '15m', label: 'Every 15 minutes' }, { value: '30m', label: 'Every 30 minutes' }, { value: '1h', label: 'Every hour' },
              { value: '6h', label: 'Every 6 hours' }, { value: '1d', label: 'Every day' }, { value: '7d', label: 'Every week' },
            ] },
          ],
          body: (values) => values,
          send: (body) => request('/_appport/schedules', 'POST', body),
          done: () => 'Schedule created.',
          after: schedules.refresh,
        }),
        report.node,
        schedules.node,
      ];
    },

    files() {
      const report = outcome();
      const files = list({
        label: 'Files',
        empty: 'No files yet',
        columns: [
          { id: 'name', header: 'Name' }, { id: 'owner', header: 'Owner' }, { id: 'size', header: 'Size (bytes)', align: 'end' },
          { id: 'key', header: 'Storage key' }, { id: 'updated', header: 'Updated' }, { id: 'actions', header: 'Actions' },
        ],
        read: () => request('/_appport/files'),
        row: (file) => ({
          key: file.id,
          attrs: { 'data-file': file.name },
          cells: {
            name: text(file.name),
            owner: text(file.owner),
            size: typeof file.size === 'number' ? file.size.toLocaleString('en-US') : undefined,
            key: file.storageKey ? el('code', {}, file.storageKey) : undefined,
            updated: when(file.updatedAt || file.createdAt),
            actions: [
              action('Rename', file.name, async () => {
                const values = await S.formDialog({
                  id: 'rename-file', title: 'Rename ' + file.name, submitLabel: 'Rename',
                  description: 'Changes the record’s name. The stored content is not touched.',
                  fields: [{ name: 'name', label: 'File name', required: true, value: file.name }],
                  action: (input) => request('/_appport/files/' + encodeURIComponent(file.id), 'PATCH', { name: input.name }),
                });
                if (values) { report.ok('Renamed to ' + values.name + '.', null, true); await files.refresh(); }
              }),
              action('Delete', file.name, () => confirmThen({
                id: 'delete-file',
                title: 'Delete the file record ' + file.name + '?',
                consequences: ['The file record is marked deleted and leaves this list.', 'The content in your storage provider is not touched.'],
                confirmLabel: 'Delete file record',
                requireText: file.name,
                action: () => request('/_appport/files/' + encodeURIComponent(file.id), 'DELETE'),
                doneMessage: 'Deleted the record for ' + file.name + '.',
              }, report, files.refresh), 'danger'),
            ],
          },
        }),
      });
      files.refresh();
      return [
        S.dom.PageHeader({ title: 'Files', description: 'Create durable file metadata records; binary content remains in your storage provider.' }),
        createForm({
          id: 'create-file', label: 'Create file record', submitLabel: 'Create file record',
          fields: [
            { name: 'name', label: 'File name', required: true },
            { name: 'storageKey', label: 'Storage key', required: true },
            { name: 'size', label: 'Size in bytes', type: 'number', min: 0, required: true },
            { name: 'contentType', label: 'Content type', placeholder: 'application/pdf' },
          ],
          // An optional field left empty is omitted, not sent as "" (which the product rejects).
          body: (values) => ({
            name: values.name, storageKey: values.storageKey, size: Number(values.size),
            ...(values.contentType ? { contentType: values.contentType } : {}),
          }),
          send: (body) => request('/_appport/files', 'POST', body),
          done: () => 'File record created.',
          after: files.refresh,
        }),
        report.node,
        files.node,
      ];
    },

    webhooks() {
      const report = outcome();
      const hooks = list({
        label: 'Webhook endpoints',
        empty: 'No webhooks yet',
        columns: [
          { id: 'url', header: 'URL' }, { id: 'events', header: 'Events' }, { id: 'created', header: 'Created' },
          { id: 'status', header: 'Status' }, { id: 'actions', header: 'Actions' },
        ],
        read: () => request('/_appport/webhooks'),
        row: (hook) => ({
          key: hook.id,
          attrs: { 'data-webhook': hook.url },
          cells: {
            url: hook.url ? el('code', {}, hook.url) : undefined,
            events: text((hook.events || []).join(', ')),
            created: when(hook.createdAt),
            status: S.dom.StatusIndicator({ field: 'appport.webhook.disabled', value: Boolean(hook.disabledAt) }),
            actions: hook.disabledAt ? [] : action('Disable', hook.url, () => confirmThen({
              id: 'disable-webhook',
              title: 'Disable the endpoint ' + hook.url + '?',
              consequences: ['No new events are delivered to this endpoint.', 'AppPort Services has no operation to enable it again; register the endpoint again instead.'],
              confirmLabel: 'Disable endpoint',
              action: () => request('/_appport/webhooks/' + encodeURIComponent(hook.id), 'DELETE'),
              doneMessage: 'Disabled ' + hook.url + '.',
            }, report, hooks.refresh), 'danger'),
          },
        }),
      });
      hooks.refresh();
      return [
        S.dom.PageHeader({ title: 'Webhooks', description: 'Register durable event endpoints for outbound delivery.' }),
        createForm({
          id: 'register-webhook', label: 'Register endpoint', submitLabel: 'Register endpoint',
          fields: [
            { name: 'url', label: 'Endpoint URL', type: 'url', required: true, placeholder: 'https://example.com/webhook' },
            { name: 'events', label: 'Events', required: true, hint: 'Comma separated, e.g. invoice.created, invoice.paid' },
            { name: 'signingCredentialRef', label: 'Signing secret reference', required: true, pattern: 'credential-ref:.+', hint: CREDENTIAL_HINT },
          ],
          body: (values) => ({
            url: values.url,
            events: values.events.split(',').map((event) => event.trim()).filter(Boolean),
            signingCredentialRef: values.signingCredentialRef,
          }),
          send: (body) => request('/_appport/webhooks', 'POST', body),
          done: () => 'Webhook endpoint registered.',
          after: hooks.refresh,
        }),
        report.node,
        hooks.node,
      ];
    },

    notifications() {
      const report = outcome();
      const run = async (path, method, message) => {
        try { changed(await request(path, method), 'The notification'); report.ok(message, null, true); await notifications.refresh(); } catch (error) { report.fail(error); }
      };
      const notifications = list({
        label: 'Notifications',
        empty: 'No notifications yet',
        columns: [
          { id: 'recipient', header: 'Recipient' }, { id: 'type', header: 'Type' }, { id: 'priority', header: 'Priority' },
          { id: 'created', header: 'Created' }, { id: 'state', header: 'State' }, { id: 'actions', header: 'Actions' },
        ],
        read: () => request('/_appport/notifications?limit=50').then((page) => page.items),
        row: (item) => {
          const name = (item.title || item.type) + ' for ' + item.recipient;
          const path = '/_appport/notifications/' + encodeURIComponent(item.id);
          return {
            key: item.id,
            attrs: { 'data-notification': item.title || item.type },
            cells: {
              recipient: text(item.recipient),
              type: text(item.type),
              priority: text(item.priority),
              created: when(item.createdAt),
              state: item.dismissedAt
                ? S.dom.StatusIndicator({ tone: 'neutral', label: 'Dismissed' })
                : S.dom.StatusIndicator({ field: 'appport.notification.status', value: item.status }),
              actions: [
                item.readAt ? null : action('Mark read', name, () => run(path + '/read', 'POST', 'Marked as read.')),
                item.dismissedAt ? null : action('Dismiss', name, () => run(path + '/dismiss', 'POST', 'Dismissed.')),
                action('Delete', name, () => confirmThen({
                  id: 'delete-notification',
                  title: 'Delete this notification?',
                  description: name,
                  consequences: ['The notification record is deleted.', 'Its delivery records are deleted with it.'],
                  confirmLabel: 'Delete notification',
                  action: () => request(path, 'DELETE'),
                  doneMessage: 'Deleted the notification.',
                }, report, notifications.refresh), 'danger'),
              ].filter(Boolean),
            },
          };
        },
      });
      notifications.refresh();
      return [
        S.dom.PageHeader({ title: 'Notifications', description: 'Create durable notification records. Attn remains the attention layer.' }),
        createForm({
          id: 'create-notification', label: 'Create notification', submitLabel: 'Create notification',
          fields: [
            { name: 'recipient', label: 'Recipient', required: true },
            { name: 'type', label: 'Notification type', required: true },
            { name: 'title', label: 'Title', required: true },
            { name: 'priority', label: 'Priority', value: 'normal', options: ['normal', 'low', 'high', 'urgent'] },
          ],
          body: (values) => values,
          send: (body) => request('/_appport/notifications', 'POST', body),
          done: () => 'Notification created.',
          after: () => notifications.refresh(),
        }),
        report.node,
        notifications.node,
      ];
    },

    configuration() {
      const api = '/v1/configuration';
      const summary = el('p', { class: 'appport-summary', role: 'status' });
      const report = outcome();
      let data = { variables: [], secrets: [], declarations: [] };
      let readError = null;
      const read = async () => {
        try {
          data = await request(api);
          readError = null;
        } catch (error) {
          readError = error;
          summary.textContent = '';
          throw error;
        }
        const missing = data.declarations.filter((declaration) => declaration.required
          && !data.variables.some((value) => value.name === declaration.name)
          && !data.secrets.some((value) => value.name === declaration.name)).length;
        summary.textContent = missing === 0 ? 'Every required value is set.'
          : missing === 1 ? '1 required value is missing.' : missing + ' required values are missing.';
        return data;
      };
      const remove = (kind, item, label) => confirmThen({
        id: 'delete-' + kind,
        title: 'Delete ' + item.name + '?',
        consequences: ['The ' + label + ' is removed from the ' + (item.environment || 'current') + ' configuration.', 'This cannot be undone; add it again to restore it.'],
        confirmLabel: 'Delete ' + label,
        requireText: item.name,
        action: () => request(api + '/' + kind + '/' + encodeURIComponent(item.name), 'DELETE'),
        doneMessage: 'Deleted ' + item.name + '.',
      }, report, refreshAll);
      const variables = list({
        label: 'Variables',
        empty: 'No variables yet',
        columns: [{ id: 'name', header: 'Name' }, { id: 'value', header: 'Value' }, { id: 'status', header: 'Status' }, { id: 'actions', header: 'Actions' }],
        read: () => read().then((result) => result.variables),
        row: (variable) => ({
          key: variable.name,
          attrs: { 'data-variable': variable.name },
          cells: {
            name: el('code', {}, variable.name),
            value: text(variable.value),
            status: S.dom.StatusIndicator({ tone: 'positive', label: 'Configured' }),
            actions: [
              action('Edit', variable.name, async () => {
                const values = await S.formDialog({
                  id: 'edit-variable', title: 'Edit ' + variable.name, submitLabel: 'Save value',
                  fields: [{ name: 'value', label: 'Value', required: true, value: variable.value }],
                  action: (input) => request(api + '/variables/' + encodeURIComponent(variable.name), 'PATCH', { value: input.value, required: false }),
                });
                if (values) { report.ok('Saved ' + variable.name + '.', null, true); await refreshAll(); }
              }),
              action('Delete', variable.name, () => remove('variables', variable, 'variable'), 'danger'),
            ],
          },
        }),
      });
      const secrets = list({
        label: 'Secrets',
        empty: 'No secrets yet',
        columns: [{ id: 'name', header: 'Name' }, { id: 'status', header: 'Status' }, { id: 'updated', header: 'Last updated' }, { id: 'actions', header: 'Actions' }],
        // The variables read fetched both; a failed read is a failure here too,
        // never an empty list.
        read: async () => { if (readError) throw readError; return data.secrets; },
        row: (secret) => ({
          key: secret.name,
          attrs: { 'data-secret': secret.name },
          cells: {
            name: el('code', {}, secret.name),
            status: S.dom.StatusIndicator({ field: 'appport.configuration.secret.configured', value: secret.configured }),
            updated: when(secret.updatedAt),
            actions: [
              action('Rotate', secret.name, async () => {
                const values = await S.formDialog({
                  id: 'rotate-secret', title: 'Rotate ' + secret.name, submitLabel: 'Rotate secret',
                  description: 'Points the secret at a new credential in AuthBoundry custody.',
                  fields: [{ name: 'credentialRef', label: 'New credential reference', required: true, pattern: 'credential-ref:.+', hint: CREDENTIAL_HINT }],
                  action: (input) => request(api + '/secrets/' + encodeURIComponent(secret.name), 'PUT', { credentialRef: input.credentialRef, required: false }),
                });
                if (values) { report.ok('Rotated ' + secret.name + '.', null, true); await refreshAll(); }
              }),
              action('Delete', secret.name, () => remove('secrets', secret, 'secret'), 'danger'),
            ],
          },
        }),
      });
      // One read serves both tables, so they always show the same moment.
      async function refreshAll() { await variables.refresh(); await secrets.refresh(); }
      const form = (kind) => createForm({
        id: 'add-' + kind,
        label: kind === 'variable' ? 'Add variable' : 'Add secret',
        submitLabel: kind === 'variable' ? 'Add variable' : 'Add secret',
        fields: [
          { name: 'name', label: 'Name', required: true, ...NAME_FIELD },
          kind === 'variable'
            ? { name: 'value', label: 'Value', required: true }
            : { name: 'credentialRef', label: 'Credential reference', required: true, pattern: 'credential-ref:.+', hint: CREDENTIAL_HINT },
        ],
        body: (values) => ({ ...values, required: false }),
        send: (body) => request(api + (kind === 'variable' ? '/variables' : '/secrets'), 'POST', body),
        done: () => (kind === 'variable' ? 'Variable added.' : 'Secret added.'),
        after: refreshAll,
      });
      refreshAll();
      return [
        // Every request on this page names no environment, so the product
        // reads and writes production (src/configuration/http.ts).
        S.dom.PageHeader({ title: 'Configuration', description: 'Variables and secret references for the production environment.' }),
        summary,
        report.node,
        // Plain sections under headings: the tables inside are already the
        // named regions, so the sections are not landmarks of their own.
        el('section', {}, [el('h2', {}, 'Variables'), variables.node, form('variable')]),
        el('section', {}, [el('h2', {}, 'Secrets'), secrets.node, form('secret')]),
      ];
    },

    secrets() {
      const secrets = list({
        label: 'Secrets',
        empty: 'No secrets yet',
        columns: [{ id: 'name', header: 'Name' }, { id: 'status', header: 'Status' }, { id: 'environment', header: 'Environment' }, { id: 'updated', header: 'Updated' }],
        read: () => request('/v1/configuration').then((result) => result.secrets),
        row: (secret) => ({
          key: secret.name,
          attrs: { 'data-secret': secret.name },
          cells: {
            name: el('code', {}, secret.name),
            status: S.dom.StatusIndicator({ field: 'appport.configuration.secret.configured', value: secret.configured }),
            environment: text(secret.environment),
            updated: when(secret.updatedAt),
          },
        }),
      });
      secrets.refresh();
      return [
        S.dom.PageHeader({ title: 'Secrets', description: 'Provider-neutral secret metadata. Values stay out of the UI and durable state snapshots.' }),
        secrets.node,
      ];
    },

    intelligence() {
      const api = '/v1/intelligence';
      const summary = el('p', { class: 'appport-summary', role: 'status' }, 'Loading intelligence configuration…');
      const credentialStatus = el('p', { class: 'appport-summary' });
      const report = outcome();
      let catalog = [];
      let current = null;
      const models = el('datalist', { id: 'intelligence-models' });
      const removeButton = S.dom.Button({ label: 'Remove credential', variant: 'danger', attrs: { 'data-remove-credential': 'true' }, onClick: () => confirmThen({
        id: 'remove-credential',
        title: 'Remove the intelligence credential?',
        consequences: ['The credential reference is detached from this application.', 'The provider and model stay configured.'],
        confirmLabel: 'Remove credential',
        action: () => request(api + '/credential', 'DELETE'),
        doneMessage: 'Credential removed.',
      }, report, load) });
      removeButton.hidden = true;
      const form = S.dom.Form({
        id: 'intelligence-form', label: 'Intelligence configuration', submitLabel: 'Save', actions: removeButton,
        children: [
          S.dom.Select({ id: 'provider', name: 'provider', label: 'Provider', required: true, options: [] }),
          S.dom.TextField({ id: 'model', name: 'model', label: 'Model', required: true, list: 'intelligence-models', hint: 'A model identifier; suggestions come from the provider’s catalog.' }),
          S.dom.Select({ id: 'endpoint-kind', name: 'endpointKind', label: 'Endpoint', options: [{ value: 'default', label: 'Default' }, { value: 'custom', label: 'Custom' }] }),
          S.dom.TextField({ id: 'endpoint', name: 'endpoint', label: 'Custom endpoint URL', type: 'url', placeholder: 'http://localhost:11434/v1' }),
          S.dom.TextField({ id: 'credential', name: 'credentialRef', label: 'API credential reference', autocomplete: 'off', pattern: 'credential-ref:.+', hint: 'Leave blank to keep the current credential. ' + CREDENTIAL_HINT }),
        ],
        onSubmit: async (event) => {
          const values = Object.fromEntries(new FormData(event.target));
          const body = { provider: values.provider, model: values.model, endpoint: values.endpointKind === 'custom' ? values.endpoint : 'default' };
          if (values.credentialRef) body.credentialRef = values.credentialRef;
          const submit = event.target.querySelector('button[type="submit"]');
          submit.disabled = true;
          submit.setAttribute('aria-busy', 'true');
          report.clear();
          try {
            await request(api, 'PUT', body);
            report.ok('Saved.');
            await load();
          } catch (error) {
            report.fail(error, 'Not saved');
          } finally {
            submit.disabled = false;
            submit.removeAttribute('aria-busy');
          }
        },
      });
      form.append(models);
      const byId = (id) => form.querySelector('#' + id);
      const provider = () => catalog.find((entry) => entry.id === byId('provider').value);
      function sync() {
        const selected = provider();
        if (!selected) return;
        models.replaceChildren(...selected.models.map((model) => el('option', { value: model.id }, model.displayName)));
        const kind = byId('endpoint-kind');
        kind.querySelector('[value="custom"]').disabled = !selected.customEndpoint;
        if (!selected.customEndpoint) kind.value = 'default';
        const custom = kind.value === 'custom';
        byId('endpoint').closest('.stack-field').hidden = !custom;
        byId('endpoint').required = custom;
        const fallback = selected.endpoints[0];
        kind.querySelector('[value="default"]').textContent = fallback ? 'Default (' + fallback.url + ')' : 'Default (none; supply a custom endpoint)';
        byId('credential').required = selected.credential === 'required' && !(current && current.credentialConfigured);
      }
      async function load() {
        let configured;
        try {
          [catalog, configured] = await Promise.all([request(api + '/catalog'), request(api)]);
        } catch (error) {
          summary.textContent = '';
          report.fail(error, 'Intelligence configuration could not be read', load);
          return;
        }
        report.clearProblem();
        current = configured;
        byId('provider').replaceChildren(...catalog.map((entry) => el('option', { value: entry.id }, entry.displayName)));
        if (configured.configured) {
          byId('provider').value = configured.provider;
          byId('model').value = configured.model;
          byId('endpoint-kind').value = configured.endpoint.kind;
          byId('endpoint').value = configured.endpoint.kind === 'custom' ? configured.endpoint.url : '';
        }
        sync();
        summary.textContent = configured.configured ? 'Configured: ' + configured.provider + ' / ' + configured.model : 'Not configured. The platform works without it.';
        credentialStatus.textContent = configured.credentialConfigured ? 'Credential: configured' : 'Credential: not configured';
        byId('credential').value = '';
        removeButton.hidden = !(configured.configured && configured.credentialConfigured && provider() && provider().credential !== 'required');
      }
      byId('provider').addEventListener('change', sync);
      byId('endpoint-kind').addEventListener('change', sync);
      load();
      return [
        S.dom.PageHeader({ title: 'Intelligence', description: 'The canonical provider, model, endpoint and credential for this application. Optional: nothing else depends on it. The credential is held in AuthBoundry custody; it is never shown here after saving.' }),
        summary,
        credentialStatus,
        report.node,
        form,
      ];
    },
  };

  // ---- Frame -------------------------------------------------------------------

  const page = (PAGES[config.page] || PAGES.overview)();
  const overview = config.navigation.find((item) => item.id === 'overview');
  document.body.prepend(S.dom.Shell({
    product: { name: 'AppPort Services', homeHref: overview ? overview.route : (config.navigation[0] || { route: '#' }).route, mark: 'A' },
    mainId: 'appport-main',
    navigation: config.navigation.map((item) => ({
      id: item.id,
      label: item.id === 'overview' ? 'Overview' : item.label,
      href: item.route,
      order: item.order,
      current: item.id === config.page,
      attrs: { 'data-surface': item.id },
    })),
    children: page,
  }));
})();
