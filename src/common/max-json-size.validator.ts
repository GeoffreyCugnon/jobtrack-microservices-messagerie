import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * Contrainte class-validator : rejette une valeur (objet / tableau) dont la
 * sérialisation JSON dépasse `maxBytes` octets UTF-8.
 *
 * Garde-fou contre un `metadata` libre qui ferait grossir sans limite la
 * colonne `Message.metadata` / `Conversation.metadata`. `undefined` et `null`
 * sont acceptés (combiner avec `@IsOptional()`).
 */
export function MaxJsonSize(maxBytes: number, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'maxJsonSize',
      target: object.constructor,
      propertyName,
      constraints: [maxBytes],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (value === undefined || value === null) {
            return true;
          }
          const [limit] = args.constraints as [number];
          try {
            return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
          } catch {
            // Référence circulaire, BigInt non sérialisable, etc.
            return false;
          }
        },
        defaultMessage(args: ValidationArguments): string {
          const [limit] = args.constraints as [number];
          return `${args.property} exceeds the maximum serialized size of ${limit} bytes`;
        },
      },
    });
  };
}
