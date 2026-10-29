// POST /api/uploads — multipart "files" (up to 5, 25 MB each). Returns the
// attachment rows; the client then posts a message with attachment_ids and
// the rows get linked to it. Unlinked rows are swept after an hour.

const express = require('express');
const files = require('../helpers/files');
const { requireAuth } = require('../helpers/sessions');

const router = express.Router();
router.use(requireAuth);

router.post('/', (req, res, next) => files.messageUpload.array('files', files.MAX_FILES_PER_MESSAGE)(req, res, (err) => files.uploadErrors(err, req, res, next)), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'no_files' });
  const out = [];
  for (const f of req.files) out.push(files.publicAttachment(await files.record({ file: f, uploaderId: req.user.id })));
  res.status(201).json({ attachments: out });
});

module.exports = router;
