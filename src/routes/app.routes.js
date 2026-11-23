const express = require('express');
const router = express.Router();

/**
 * VikasBuilds State 35: App Version & Mandatory Update Check Endpoint
 * Returns minimum supported version, latest version, store URLs, and release notes.
 */
router.get('/version', (req, res) => {
  const currentClientVersion = req.query.version || '1.0.0';
  const minSupportedVersion = process.env.MIN_SUPPORTED_VERSION || '1.0.0';
  const latestVersion = process.env.LATEST_APP_VERSION || '1.2.0';

  // Compare semantic versions
  const isOutdated = compareSemVer(currentClientVersion, minSupportedVersion) < 0;

  return res.status(200).json({
    success: true,
    data: {
      minSupportedVersion,
      latestVersion,
      forceUpdate: isOutdated,
      storeUrl:
        process.env.APP_STORE_URL ||
        'https://play.google.com/store/apps/details?id=com.gurukul.chatting',
      releaseNotes: [
        'Critical backend security and session token protocols.',
        'Real-time classroom Google Meet integration & waiting queue.',
        'Low-latency message synchronization and voice notes.',
      ],
      checkTimestamp: new Date(),
    },
  });
});

function compareSemVer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

module.exports = router;
