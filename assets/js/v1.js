console.log('init');

let playing = false;
let audio = null;
let volume = localStorage.getItem('volume') || 0.1;

$('.volume').val(volume);

$('.play-button').on('click', (e) => {
  e.preventDefault();

  if (!playing) {
    $('.play-button i').removeClass('fa-play').addClass('fa-pause');
    audio = new Audio(`https://live.freshradio.pw?cacheBuster=${Math.ceil(Math.random() * 40000)}`);
    audio.volume = volume;
    playing = true;
    audio.play();
  } else {
    playing = false;
    $('.play-button i').addClass('fa-play').removeClass('fa-pause');
    audio.pause();
    audio.src = "";
    audio = null;
  }
});

$('.volume').on('change', (e) => {
  e.preventDefault();
  volume = e.target.value;
  localStorage.setItem('volume', e.target.value)
  if (audio) {
    audio.volume = e.target.value;
  }
})

const authHeaders = {
	'Authorization': 'Basic ZTVhNGQ1MTAtZGY4Mi00NDMzLWFjYjEtNjc0N2Y0YTA0MGI1Og==',
	'X-Tenant': 'b8ad4d76-4c8b-4cc7-b93c-eca4d6438e2e',
};

const fetchSongData = () => {
	fetch('https://api.radiopanel.co/api/v1/song-history/now-playing', {
		headers: authHeaders
	})
  .then((result) => result.json())
  .then(({ song }) => {
    $('.song-name').text(song.title);
    $('.song-artist').text(song.artist);
    $('.song-art:not(.dj-art)').attr('src', song.graphic.medium || "https://freshradio.pw/images/FRESH%20NEW.png")
    $('.song-background img').attr('src', song.graphic.medium || "https://freshradio.pw/images/FRESH%20NEW.png")
  });
};

const fetchSlotData = () => {
	fetch('https://api.radiopanel.co/api/v1/slots/live', {
		headers: authHeaders
	})
  .then((result) => result.json())
  .then((result) => {
    $('.dj-name').text(`${result.user.firstName} ${result.user.lastName}`);
    $('.dj-art').attr('src', result.user.avatar);
    $('.dj-background img').attr('src', result.user.avatar || "https://freshradio.pw/images/FRESH%20NEW.png");

    $('.presenter-live .presenter-name').text(`${result.user.firstName} ${result.user.lastName}`);
    $('.presenter-live .presenter-time').text(`${moment.unix(result.start).format('HH:mm')}-${moment.unix(result.end).format('HH:mm')}`);
    $('.presenter-live .presenter-image').attr('src', result.user.avatar || "https://freshradio.pw/images/FRESH%20NEW.png");
  })
  .catch(() => {
    $('.dj-name').text('AutoDJ');
    $('.dj-art').attr('src', 'https://freshradio.pw/images/FRESH%20NEW.png');
    $('.dj-background img').attr('src', 'https://freshradio.pw/images/FRESH%20NEW.png');

    $('.presenter-live .presenter-name').text('Fresh Stream');
    $('.presenter-live .presenter-time').text("");
    $('.presenter-live .presenter-image').attr('src', 'https://freshradio.pw/images/FRESH%20NEW.png');
  });

	fetch('https://api.radiopanel.co/api/v1/slots/next', {
		headers: authHeaders
	})
  .then((result) => result.json())
  .then((result) => {
    $('.presenter-next .presenter-name').text(`${result.user.firstName} ${result.user.lastName}`);
    $('.presenter-next .presenter-time').text(`${moment.unix(result.start).format('HH:mm')}-${moment.unix(result.end).format('HH:mm')}`);
    $('.presenter-next .presenter-image').attr('src', result.user.avatar || "https://freshradio.pw/images/FRESH%20NEW.png");
  })
  .catch(() => {
    $('.presenter-next .presenter-name').text('Fresh Stream');
    $('.presenter-next .presenter-time').text("");
    $('.presenter-next .presenter-image').attr('src', 'https://freshradio.pw/images/FRESH%20NEW.png');
  });

	fetch('https://api.radiopanel.co/api/v1/slots/later', {
		headers: authHeaders
	})
  .then((result) => result.json())
  .then((result) => {
    $('.presenter-later .presenter-name').text(`${result.user.firstName} ${result.user.lastName}`);
    $('.presenter-later .presenter-time').text(`${moment.unix(result.start).format('HH:mm')}-${moment.unix(result.end).format('HH:mm')}`);
    $('.presenter-later .presenter-image').attr('src', result.user.avatar || "https://freshradio.pw/images/FRESH%20NEW.png");
  })
  .catch(() => {
    $('.presenter-later .presenter-name').text('Fresh Stream');
    $('.presenter-later .presenter-time').text("");
    $('.presenter-later .presenter-image').attr('src', 'https://freshradio.pw/images/FRESH%20NEW.png');
  });

  fetch('https://app.radiopanel.co/api/v1/song-history?pagesize=3', {
    headers: authHeaders,
  })
    .then((result) => result.json())
    .then(({ _embedded }) => {
      $('.song-history-container').html(null);
      _embedded.forEach((songPlay) => {
        $('.song-history-container').append(`
          <div class="song-history-item">
            <img src="${(songPlay.song.graphic && songPlay.song.graphic.large) || "https://freshradio.pw/images/FRESH%20NEW.png"}" alt="" class="song-history-item-image">
            <div class="song-history-item-info">
              <p class="song-history-item-subtitle">Played ${moment(songPlay.createdAt).fromNow()}</p>
              <p class="song-history-item-name">${songPlay.song.artist} - ${songPlay.song.title}</p>
            </div>
          </div>
        `)
      })
    });
}

$('.request-form').on('submit', (e) => {
  e.preventDefault();
  const formValues = $('.request-form').serializeArray().reduce((acc, item) => ({
    ...acc,
    [item.name]: item.value,
  }), {});

  fetch('https://app.radiopanel.co/api/v1/requests', {
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json'
    },
    method: 'POST',
    body: JSON.stringify(formValues)
  })
    .then((result) => result.json())
    .then((result) => {
      if (result.uuid) {
        $('.m-modal-container').hide();
        $('.a-input input, .a-input textarea, .a-input select').val('');
        toastr.success('Thank you for your request');
        return;
      }

      toastr.error(result.message);
    })
})

$('.request-song').on('click', (e) => {
  e.preventDefault();
  $('.m-modal-container').show();
})

$('.close-button').on('click', (e) => {
  e.preventDefault();
  $('.m-modal-container').hide();
})

fetchSongData();
fetchSlotData();

setInterval(fetchSongData, 10*1000);
setInterval(fetchSlotData, 1*60*1000);
