import type {Metadata} from 'next';
import {Inter, JetBrains_Mono} from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'WebRTC P2P File Transfer',
  description: 'Premium macOS-inspired peer-to-peer file transfer over WebRTC DataChannel',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var currentFetch = window.fetch;
                  var desc = {
                    get: function() { return currentFetch; },
                    set: function(val) { currentFetch = val; },
                    configurable: true,
                    enumerable: true
                  };
                  Object.defineProperty(window, 'fetch', desc);
                  if (typeof globalThis !== 'undefined') {
                    Object.defineProperty(globalThis, 'fetch', desc);
                  }
                  if (typeof self !== 'undefined') {
                    Object.defineProperty(self, 'fetch', desc);
                  }
                } catch (e) {
                  // Gracefully ignore
                }
              })();
            `
          }}
        />
      </head>
      <body className="antialiased font-sans bg-neutral-950 text-neutral-100 selection:bg-white/10 min-h-screen flex flex-col justify-between overflow-x-hidden" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
