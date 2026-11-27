'use client';

import type { ComponentProps } from 'react';

type IntegerQuantityInputProps = Omit<ComponentProps<'input'>, 'type' | 'inputMode' | 'step' | 'onWheel'>;

export function IntegerQuantityInput(props: IntegerQuantityInputProps) {
  return <input {...props} type="number" inputMode="numeric" step={1} onWheel={event => event.currentTarget.blur()} />;
}
