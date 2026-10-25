import { Calculator, ClipboardList, ChevronRight, Image as ImageIcon, ScanLine, Stamp, Wrench } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const tools = [
  { name: 'Рабочий стол продаж', href: '/sales/', Icon: ClipboardList },
  { name: 'Визуализация', href: '/signs/', Icon: ImageIcon },
  { name: 'Оттиск', href: '/tools/stamp/', Icon: Stamp },
  { name: 'Калькулятор вывесок', href: '/calculator/', Icon: Calculator },
  { name: 'Примерка вывески', href: '/fonts/', Icon: ScanLine },
];

function ToolLinks() {
  return (
    <DropdownMenuGroup>
      {tools.map(({ name, href, Icon }) => (
        <DropdownMenuItem key={href} className="gap-3 px-3 py-2.5" render={<a href={href} target="_blank" rel="noopener noreferrer" aria-label={name} />}>
          <Icon />{name}
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
}

export function ToolsMenu({ className }: { className: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={className} aria-label="Инструменты">
        <Wrench size={18} /><span>Инструменты</span><ChevronRight size={15} className="ml-auto" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-52 max-w-[calc(100vw-2rem)]">
        <ToolLinks />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ToolsSubmenu() {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-3 px-2 py-2.5"><Wrench />Инструменты</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-48 max-w-[calc(100vw-2rem)]">
        <ToolLinks />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
