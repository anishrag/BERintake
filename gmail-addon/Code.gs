/**
 * BER Checklist — Gmail Workspace Add-on.
 *
 * When a client email is opened, resolves it to the open BER job(s) awaiting
 * details and shows the outstanding checklist. For each item you attach what the
 * client sent — one or more of the email's attachments and/or the email itself
 * as a PDF — and Save uploads them to S3 under that item and ticks it off. When
 * the last item is done the job moves to `details_provided`.
 *
 * Config (Script Properties — Project Settings ▸ Script Properties):
 *   ADDON_KEY   the x-addon-key secret (BERintake ADDON_ACCESS_KEY). Required.
 *   API_BASE    override the API base URL (optional; defaults below).
 *
 * The email's Reply-To is the client's address (the visible From is the
 * forwards@ forwarder), so we match on Reply-To, with subject+body as hints.
 */

var DEFAULT_API_BASE = 'https://snji0w7hvi.execute-api.us-east-1.amazonaws.com';

function apiBase_() {
  return (
    PropertiesService.getScriptProperties().getProperty('API_BASE') ||
    DEFAULT_API_BASE
  );
}

function addonKey_() {
  return PropertiesService.getScriptProperties().getProperty('ADDON_KEY') || '';
}

/**
 * Run this ONCE from the editor (Run ▸ forceAuthorize) to grant the add-on's
 * scopes — external_request + Gmail — after a manifest change. Accept consent.
 */
function forceAuthorize() {
  UrlFetchApp.fetch(apiBase_() + '/jobs/lookup?email=auth@check.test', {
    headers: { 'x-addon-key': addonKey_() },
    muteHttpExceptions: true,
  });
  Logger.log('Authorized. API base=%s, key set=%s', apiBase_(), !!addonKey_());
}

/** Contextual trigger — fires when a Gmail message is opened (web + mobile). */
function onGmailMessageOpen(e) {
  var message = currentMessage_(e);
  var clientEmail = extractEmail_(message.getReplyTo() || message.getFrom());
  var hints = ((message.getSubject() || '') + '\n' + (message.getPlainBody() || '')).substring(
    0,
    4000,
  );
  var attMeta = metaFrom_(attachmentsOf_(message));

  var resp = lookup_(clientEmail, hints);
  if (resp.code !== 200) {
    var hint =
      resp.code === 401
        ? 'Auth rejected (401) — set/fix the ADDON_KEY script property, then re-open the email.'
        : resp.code === -1
          ? 'Network error: ' + resp.text
          : 'HTTP ' + resp.code + ': ' + resp.text.substring(0, 160);
    return [errorCard_('Lookup failed. ' + hint)];
  }
  var matches = (JSON.parse(resp.text).matches) || [];
  if (matches.length === 0) return [noMatchCard_(clientEmail)];
  if (matches.length === 1) return [checklistCard_(matches[0], attMeta)];
  return [pickerCard_(matches, clientEmail)];
}

// ---- Gmail message helpers ------------------------------------------------

function currentMessage_(e) {
  if (!e || !e.gmail || !e.gmail.messageId) return null;
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  return GmailApp.getMessageById(e.gmail.messageId);
}

function attachmentsOf_(message) {
  if (!message) return [];
  return message.getAttachments({ includeInlineImages: false, includeAttachments: true });
}

/** Lightweight [{name, contentType, index}] for the card's source list. */
function metaFrom_(attachments) {
  return attachments.map(function (a, idx) {
    return { name: a.getName(), contentType: a.getContentType(), index: idx };
  });
}

/** First email address in a header value, lowercased. */
function extractEmail_(s) {
  if (!s) return '';
  var m = s.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : '';
}

// ---- API ------------------------------------------------------------------

function lookup_(email, hints) {
  var url =
    apiBase_() +
    '/jobs/lookup?email=' +
    encodeURIComponent(email) +
    '&hints=' +
    encodeURIComponent(hints);
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'x-addon-key': addonKey_() },
      muteHttpExceptions: true,
    });
    return { code: res.getResponseCode(), text: res.getContentText() };
  } catch (err) {
    return { code: -1, text: String(err) };
  }
}

function postJson_(path, body) {
  var res = UrlFetchApp.fetch(apiBase_() + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-addon-key': addonKey_() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 140));
  }
  return JSON.parse(res.getContentText());
}

function postChecklist_(jobId, updates) {
  return postJson_('/jobs/' + encodeURIComponent(jobId) + '/checklist', {
    updates: updates,
    source: 'gmail_addon',
  });
}

// ---- Cards ----------------------------------------------------------------

function checklistCard_(match, attMeta) {
  return buildChecklistCard_(
    match.job_id,
    match.client_name,
    match.property_address,
    match.checklist,
    attMeta || [],
  );
}

function buildChecklistCard_(jobId, clientName, address, checklist, attMeta) {
  var items = (checklist && checklist.items) || [];
  var outstanding = items.filter(function (i) {
    return !i.done;
  });
  var done = items.filter(function (i) {
    return i.done;
  });

  var card = CardService.newCardBuilder().setHeader(
    CardService.newCardHeader().setTitle(address || 'BER job').setSubtitle(clientName || ''),
  );

  card.addSection(
    CardService.newCardSection().addWidget(
      CardService.newTextParagraph().setText(
        '<b>Waiting on ' + outstanding.length + ' of ' + items.length + ' items</b>',
      ),
    ),
  );

  // One multi-select group per item: the email-as-PDF plus every attachment.
  // Not mutually exclusive — a point can take several files.
  function itemWidget_(i) {
    var onFile = (i.attachments && i.attachments.length) || 0;
    var sel = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('sel_' + i.item_id)
      .setTitle(i.label + (onFile ? '  (' + onFile + ' on file)' : ''));
    sel.addItem('✉️ This email (as PDF)', 'email', false);
    attMeta.forEach(function (a) {
      sel.addItem('📎 ' + a.name, 'att:' + a.index, false);
    });
    return sel;
  }

  if (outstanding.length > 0) {
    var out = CardService.newCardSection().setHeader('Attach what the client sent');
    outstanding.forEach(function (i) {
      out.addWidget(itemWidget_(i));
    });
    card.addSection(out);
  } else if (items.length > 0) {
    card.addSection(
      CardService.newCardSection().addWidget(
        CardService.newTextParagraph().setText(
          '✅ All items received — job moved to <b>details provided</b>.',
        ),
      ),
    );
  }

  if (done.length > 0) {
    var doneSection = CardService.newCardSection()
      .setHeader('Already received (' + done.length + ') — tap to add more')
      .setCollapsible(true)
      .setNumUncollapsibleWidgets(0);
    done.forEach(function (i) {
      var files = (i.attachments || [])
        .map(function (a) {
          return a.filename;
        })
        .join(', ');
      doneSection.addWidget(
        CardService.newDecoratedText()
          .setText('<font color="#2e7d32">✓ ' + i.label + '</font>')
          .setBottomLabel(files || 'no file'),
      );
      doneSection.addWidget(itemWidget_(i));
    });
    card.addSection(doneSection);
  }

  var labels = {};
  items.forEach(function (i) {
    labels[i.item_id] = i.label;
  });
  var saveButton = CardService.newTextButton()
    .setText('Save')
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setOnClickAction(
      CardService.newAction().setFunctionName('saveTicks_').setParameters({
        jobId: jobId,
        clientName: clientName || '',
        address: address || '',
        labels: JSON.stringify(labels),
      }),
    );
  card.addSection(
    CardService.newCardSection().addWidget(CardService.newButtonSet().addButton(saveButton)),
  );

  return card.build();
}

/**
 * Save action: for every selected source (email-PDF or an attachment) build a
 * blob, upload it to S3 via a presigned PUT, then record it on its item + mark
 * done. Re-renders from authoritative state.
 */
function saveTicks_(e) {
  var p = e.parameters || {};
  var labels = {};
  try {
    labels = JSON.parse(p.labels || '{}');
  } catch (x) {}
  var message = currentMessage_(e);
  var attachments = attachmentsOf_(message);
  var inputs = e.formInputs || {};
  var prefix = shortName_(p.address || p.clientName || 'BER');
  var used = {};

  var files = []; // {item_id, filename, contentType, blob}
  Object.keys(inputs).forEach(function (field) {
    if (field.indexOf('sel_') !== 0) return;
    var itemId = field.substring(4);
    var label = labels[itemId] || itemId;
    (inputs[field] || []).forEach(function (val) {
      var blob, ct, ext, src;
      if (val === 'email') {
        if (!message) return;
        blob = emailPdfBlob_(message);
        ct = 'application/pdf';
        ext = 'pdf';
        src = 'email';
      } else if (val.indexOf('att:') === 0) {
        var att = attachments[parseInt(val.substring(4), 10)];
        if (!att) return;
        blob = att.copyBlob();
        ct = att.getContentType();
        ext = extOf_(att.getName()) || 'bin';
        src = baseName_(att.getName());
      } else {
        return;
      }
      var fname = uniq_(used, itemId, sanitize_(prefix + ' - ' + label + ' - ' + src) + '.' + ext);
      files.push({ item_id: itemId, filename: fname, contentType: ct, blob: blob });
    });
  });

  if (files.length === 0) return notify_('Nothing selected to attach');

  try {
    var presign = postJson_('/jobs/' + encodeURIComponent(p.jobId) + '/checklist/presign', {
      files: files.map(function (f) {
        return { item_id: f.item_id, filename: f.filename, contentType: f.contentType };
      }),
    });
    var byItem = {};
    (presign.uploads || []).forEach(function (u) {
      var f = files.filter(function (x) {
        return x.item_id === u.item_id && x.filename === u.filename;
      })[0];
      if (!f) return;
      var put = UrlFetchApp.fetch(u.url, {
        method: 'put',
        contentType: u.contentType,
        payload: f.blob.getBytes(),
        muteHttpExceptions: true,
      });
      if (put.getResponseCode() >= 300) throw new Error('upload failed (' + put.getResponseCode() + ')');
      (byItem[u.item_id] = byItem[u.item_id] || []).push({
        key: u.key,
        filename: u.filename,
        contentType: u.contentType,
      });
    });

    var updates = Object.keys(byItem).map(function (id) {
      return { item_id: id, done: true, attachments: byItem[id] };
    });
    var resp = postChecklist_(p.jobId, updates);
    var card = buildChecklistCard_(
      p.jobId,
      p.clientName,
      p.address,
      resp.checklist,
      metaFrom_(attachments),
    );
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(card))
      .setNotification(
        CardService.newNotification().setText(
          resp.status === 'details_provided'
            ? 'Uploaded — all done, details provided'
            : 'Uploaded ' + files.length + ' file(s)',
        ),
      )
      .build();
  } catch (err) {
    return notify_('Save failed: ' + err);
  }
}

/** Several open jobs for one client — let the assessor pick. */
function pickerCard_(matches, email) {
  var section = CardService.newCardSection().setHeader('Multiple open jobs matched');
  matches.forEach(function (m) {
    section.addWidget(
      CardService.newDecoratedText()
        .setTopLabel(m.client_name || '')
        .setText(m.property_address || m.job_id)
        .setBottomLabel(m.checklist.outstanding_count + ' outstanding')
        .setButton(
          CardService.newTextButton()
            .setText('Open')
            .setOnClickAction(
              CardService.newAction()
                .setFunctionName('showJob_')
                .setParameters({ jobId: m.job_id, email: email }),
            ),
        ),
    );
  });
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('BER Checklist'))
    .addSection(section)
    .build();
}

function showJob_(e) {
  var p = e.parameters || {};
  var resp = lookup_(p.email, '');
  var matches = resp.code === 200 ? JSON.parse(resp.text).matches || [] : [];
  var match = matches.filter(function (m) {
    return m.job_id === p.jobId;
  })[0];
  var attMeta = metaFrom_(attachmentsOf_(currentMessage_(e)));
  var card = match
    ? checklistCard_(match, attMeta)
    : errorCard_('That job is no longer open for details.');
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card))
    .build();
}

function noMatchCard_(email) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('BER Checklist'))
    .addSection(
      CardService.newCardSection().addWidget(
        CardService.newTextParagraph().setText(
          email ? 'No open BER job matched ' + email + '.' : 'No open BER job matched this email.',
        ),
      ),
    )
    .build();
}

function errorCard_(msg) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('BER Checklist'))
    .addSection(
      CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(msg)),
    )
    .build();
}

// ---- Small helpers --------------------------------------------------------

function emailPdfBlob_(message) {
  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px">' +
    '<h3>' +
    escapeHtml_(message.getSubject() || '(no subject)') +
    '</h3>' +
    '<p style="color:#555"><b>From:</b> ' +
    escapeHtml_(message.getFrom()) +
    '<br><b>Date:</b> ' +
    escapeHtml_(String(message.getDate())) +
    '</p><hr>' +
    (message.getBody() || escapeHtml_(message.getPlainBody() || '')) +
    '</div>';
  return Utilities.newBlob(html, 'text/html', 'email.html').getAs('application/pdf');
}

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function baseName_(name) {
  name = String(name || '');
  var d = name.lastIndexOf('.');
  return d > 0 ? name.substring(0, d) : name;
}

function extOf_(name) {
  name = String(name || '');
  var d = name.lastIndexOf('.');
  return d > 0 ? name.substring(d + 1).toLowerCase() : '';
}

function sanitize_(s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9 ._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortName_(addr) {
  return sanitize_(String(addr || '').split(',')[0]).substring(0, 40) || 'BER';
}

/** Ensure a filename is unique within one item (S3 keys must not collide). */
function uniq_(used, itemId, name) {
  var set = (used[itemId] = used[itemId] || {});
  if (!set[name]) {
    set[name] = true;
    return name;
  }
  var d = name.lastIndexOf('.');
  var base = d > 0 ? name.substring(0, d) : name;
  var ext = d > 0 ? name.substring(d) : '';
  var n = 2;
  while (set[base + '-' + n + ext]) n++;
  var out = base + '-' + n + ext;
  set[out] = true;
  return out;
}

function notify_(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}
