// Twilio SMS notification

export async function notifyDennis(env, message) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.log('[SMS] twilio not configured, skipping notification');
    return;
  }

  const body = message.substring(0, 1500);

  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: env.DENNIS_PHONE,
          From: env.TWILIO_FROM_NUMBER,
          Body: body,
        }),
      }
    );

    if (resp.ok) {
      console.log('[SMS] notification sent');
    } else {
      const err = await resp.text();
      console.log(`[SMS] failed: ${resp.status} ${err}`);
    }
  } catch (err) {
    console.log(`[SMS] error: ${err.message}`);
  }
}
