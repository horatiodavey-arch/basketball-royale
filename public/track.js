// Reports a tap that never reaches the server on its own — an Invite
// button only opens the phone's share sheet — so it still shows up in
// the organizer's click tracking. Fire-and-forget: tracking must never
// get in the way of the thing the player actually tapped.
window.RoyaleTrack = {
  report: function (name) {
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).catch(function () {});
  },
};
