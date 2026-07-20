/**
 * BER Checklist — Gmail Workspace Add-on.
 *
 * When a client email is opened, resolves it to the open BER job(s) awaiting
 * details and shows the outstanding checklist. Ticking items off writes back to
 * the BERintake API; when the last item is ticked the job moves to
 * `details_provided`.
 *
 * Config (Script Properties — File ▸ Project Settings ▸ Script Properties):
 *   ADDON_KEY   the x-addon-key secret (BERintake ADDON_ACCESS_KEY). Required.
 *   API_BASE    override the API base URL (optional; defaults below).
 *
 * The email's Reply-To is the client's address (the visible From is the
 * forwards@ forwarder), so we match on Reply-To, with the subject+body as hints.
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

/** Contextual trigger — fires when a Gmail message is opened (web + mobile). */
function onGmailMessageOpen(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  var message = GmailApp.getMessageById(e.gmail.messageId);

  var clientEmail = extractEmail_(message.getReplyTo() || message.getFrom());
  var subject = message.getSubject() || '';
  var body = message.getPlainBody() || '';
  var hints = (subject + '\n' + body).substring(0, 4000);

  var resp = lookup_(clientEmail, hints);
  if (resp === null) {
    return [errorCard_('Could not reach the checklist service. Re-open the email to retry.')];
  }
  var matches = resp.matches || [];
  if (matches.length === 0) return [noMatchCard_()];
  if (matches.length === 1) return [checklistCard_(matches[0])];
  return [pickerCard_(matches, clientEmail)];
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
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText());
  } catch (err) {
    return null;
  }
}

function postChecklist_(jobId, updates) {
  var res = UrlFetchApp.fetch(apiBase_() + '/jobs/' + encodeURIComponent(jobId) + '/checklist', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-addon-key': addonKey_() },
    payload: JSON.stringify({ updates: updates, source: 'gmail_addon' }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('save failed: ' + res.getResponseCode());
  return JSON.parse(res.getContentText());
}

// ---- Cards ----------------------------------------------------------------

function checklistCard_(match) {
  return buildChecklistCard_(
    match.job_id,
    match.client_name,
    match.property_address,
    match.checklist,
  );
}

function buildChecklistCard_(jobId, clientName, address, checklist) {
  var items = (checklist && checklist.items) || [];
  var outstanding = items.filter(function (i) {
    return !i.done;
  });
  var done = items.filter(function (i) {
    return i.done;
  });

  var card = CardService.newCardBuilder().setHeader(
    CardService.newCardHeader()
      .setTitle(address || 'BER job')
      .setSubtitle(clientName || ''),
  );

  card.addSection(
    CardService.newCardSection().addWidget(
      CardService.newTextParagraph().setText(
        '<b>Waiting on ' + outstanding.length + ' of ' + items.length + ' items</b>',
      ),
    ),
  );

  if (outstanding.length > 0) {
    var checkboxes = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('ticked')
      .setTitle('Tick what the client just supplied');
    outstanding.forEach(function (i) {
      checkboxes.addItem(i.label, i.item_id, false);
    });
    var saveButton = CardService.newTextButton()
      .setText('Save ticked items')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('saveTicks_')
          .setParameters({ jobId: jobId, clientName: clientName || '', address: address || '' }),
      );
    card.addSection(
      CardService.newCardSection()
        .addWidget(checkboxes)
        .addWidget(CardService.newButtonSet().addButton(saveButton)),
    );
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
      .setHeader('Already received')
      .setCollapsible(true)
      .setNumUncollapsibleWidgets(0);
    done.forEach(function (i) {
      doneSection.addWidget(
        CardService.newDecoratedText().setText('<font color="#888888">✓ ' + i.label + '</font>'),
      );
    });
    card.addSection(doneSection);
  }

  return card.build();
}

/** Save action: batch the ticked items, re-render from authoritative state. */
function saveTicks_(e) {
  var p = e.parameters || {};
  var ticked = (e.formInputs && e.formInputs.ticked) || [];
  if (ticked.length === 0) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('Nothing ticked'))
      .build();
  }
  var updates = ticked.map(function (id) {
    return { item_id: id, done: true };
  });
  try {
    var resp = postChecklist_(p.jobId, updates);
    var card = buildChecklistCard_(p.jobId, p.clientName, p.address, resp.checklist);
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(card))
      .setNotification(
        CardService.newNotification().setText(
          resp.status === 'details_provided' ? 'All done — details provided' : 'Saved',
        ),
      )
      .build();
  } catch (err) {
    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification().setText('Save failed — try again in a moment'),
      )
      .build();
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

/** Picker → open one job's checklist (re-lookup by email, filter to jobId). */
function showJob_(e) {
  var p = e.parameters || {};
  var resp = lookup_(p.email, '');
  var match =
    resp &&
    (resp.matches || []).filter(function (m) {
      return m.job_id === p.jobId;
    })[0];
  var card = match
    ? checklistCard_(match)
    : errorCard_('That job is no longer open for details.');
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card))
    .build();
}

function noMatchCard_() {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('BER Checklist'))
    .addSection(
      CardService.newCardSection().addWidget(
        CardService.newTextParagraph().setText('No open BER job matched this email.'),
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
