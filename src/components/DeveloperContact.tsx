import React from 'react';
import { MessageCircle } from 'lucide-react';
import Popover from './Popover';

const CONTACT_URL = 'https://telemost.yandex.ru/p/9c3f6f07-4eba-9481-47e6-e9620531a4da?utm_source=invite';

interface DeveloperContactProps {
  buttonClassName: string;
  buttonStyle: React.CSSProperties;
}

/** Контакт разработчика закреплён за кнопкой верхней панели даже при переносе окна. */
export default function DeveloperContact({ buttonClassName, buttonStyle }: DeveloperContactProps) {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);

  const openContact = async () => {
    const electron = (window as any).electron;
    if (electron?.openExternal) {
      try {
        const result = await electron.openExternal(CONTACT_URL);
        if (result?.success === false) window.open(CONTACT_URL, '_blank', 'noopener,noreferrer');
      } catch {
        window.open(CONTACT_URL, '_blank', 'noopener,noreferrer');
      }
    } else {
      window.open(CONTACT_URL, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Связь с разработчиком"
        aria-label="Связь с разработчиком"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={buttonStyle}
        className={`${buttonClassName} relative rounded-lg ${open ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`}
      >
        <MessageCircle className="w-3.5 h-3.5" />
      </button>
      {open && (
        <Popover anchor={buttonRef.current} onClose={() => setOpen(false)} align="right" label="Связь с разработчиком" className="!p-3">
          <div className="flex items-center gap-3 min-w-[230px]">
            <span className="flex-1 text-sm text-slate-700 dark:text-slate-300">Связь с разработчиком в Телемосте</span>
            <button type="button" onClick={openContact} className="fx-btn fx-btn-primary fx-btn-sm shrink-0">Написать</button>
          </div>
        </Popover>
      )}
    </>
  );
}
