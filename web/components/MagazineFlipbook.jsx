'use client';

import { useState } from 'react';
import styles from './MagazineFlipbook.module.css';

/**
 * Heyzine flipbook embed for foodstories.shop.
 *
 * Shows the cover first and only loads the Heyzine iframe when the reader
 * clicks, so the page stays fast. Pass autoLoad to skip the cover.
 *
 * <MagazineFlipbook src="https://heyzine.com/flip-book/XXXXXXXX.html" />
 */
export default function MagazineFlipbook({
  src,
  cover = '/magazine/cover.jpg',
  title = 'Food Stories Magazine',
  cta = 'Read the magazine',
  autoLoad = false,
}) {
  const [open, setOpen] = useState(autoLoad);

  return (
    <section className={styles.frame} aria-label={title}>
      {open ? (
        <iframe
          className={styles.iframe}
          src={src}
          title={title}
          allow="fullscreen"
          allowFullScreen
          scrolling="no"
        />
      ) : (
        <button type="button" className={styles.facade} onClick={() => setOpen(true)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.cover} src={cover} alt={`${title} cover`} />
          <span className={styles.cta}>{cta}</span>
        </button>
      )}
    </section>
  );
}
