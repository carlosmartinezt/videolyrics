/**
 * The splash page at videolyrics.org: analytics and the email form.
 * The form posts to api/subscribe.js, a Vercel function.
 */

import { initAnalytics } from './lib/analytics';
import './splash.css';

initAnalytics();

const form = document.getElementById('signup') as HTMLFormElement;
const note = document.getElementById('signup-note') as HTMLParagraphElement;
const button = form.querySelector('button') as HTMLButtonElement;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const email = String(data.get('email') ?? '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    note.textContent = 'That does not look like an email address.';
    note.dataset.state = 'bad';
    return;
  }

  button.disabled = true;
  note.textContent = 'Sending...';
  delete note.dataset.state;

  try {
    const response = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, website: data.get('website') ?? '' }),
    });
    if (!response.ok) throw new Error(String(response.status));
    form.reset();
    note.textContent = "You're on the list. We'll email you when it opens.";
    note.dataset.state = 'ok';
    window.gtag?.('event', 'signup');
  } catch {
    note.textContent = 'That did not go through. Please try again in a minute.';
    note.dataset.state = 'bad';
  } finally {
    button.disabled = false;
  }
});
