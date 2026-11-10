// The camera button on a park's page and bottom sheet (see
// views/partials/park-photo-button.ejs). Tapping it opens the phone's
// camera — or a photo picker where there's no camera to open — shrinks
// the picture, and sends it off for an organizer to review.
(function () {
  var MAX_WIDTH = 1600;

  // Shrink before uploading, so a multi-megabyte camera photo doesn't
  // cross a phone connection at full size. The server resizes and
  // re-encodes whatever arrives regardless; if this browser can't decode
  // the file to shrink it, the original is sent and the server handles it.
  function shrink(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_WIDTH / img.naturalWidth);
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) { resolve(blob || file); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  document.querySelectorAll('.park-photo-add').forEach(function (wrap) {
    var button = wrap.querySelector('.camera-btn');
    var input = wrap.querySelector('input[type="file"]');
    var statusEl = document.getElementById(wrap.getAttribute('data-status-id'));
    var parkId = wrap.getAttribute('data-park-id');
    var canAdd = wrap.getAttribute('data-can-add') === '1';

    function say(text) {
      if (statusEl) statusEl.textContent = text;
    }

    button.addEventListener('click', function () {
      if (!canAdd) { say('Check in at this park to add a photo.'); return; }
      input.click();
    });

    input.addEventListener('change', function () {
      var file = input.files[0];
      input.value = '';
      if (!file) return;

      button.disabled = true;
      say('Sending your photo…');
      shrink(file)
        .then(function (blob) {
          var type = blob.type && blob.type.indexOf('image/') === 0 ? blob.type : 'image/jpeg';
          return fetch('/parks/' + parkId + '/photos', {
            method: 'POST',
            headers: { 'Content-Type': type },
            body: blob,
          });
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          say(data.ok ? data.message : (data.error || "Couldn't send that photo."));
        })
        .catch(function () { say("Couldn't send that photo. Try again."); })
        .then(function () { button.disabled = false; });
    });
  });
})();
