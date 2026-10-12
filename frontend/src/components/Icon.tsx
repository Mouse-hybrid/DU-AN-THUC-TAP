interface IconProps {
  name: string;
  className?: string;
}

export function Icon({ name, className = "nova-icon" }: IconProps) {
  return (
    <svg className={className} aria-hidden="true">
      <use href={`/icons/lucide-sprite.svg#${name}`} />
    </svg>
  );
}
