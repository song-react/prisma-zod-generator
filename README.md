# prisma-zod-generator

Minimal Prisma generator that emits Zod schemas from your Prisma models.

## Install (GitHub)

```sh
npm i -D github:YOUR_GITHUB_USERNAME/prisma-zod-generator
# or
npm i -D git+ssh://git@github.com/YOUR_GITHUB_USERNAME/prisma-zod-generator.git
```

## Usage

Add the generator to `schema.prisma`:

```prisma
generator zod {
  provider = "node_modules/prisma-zod-generator"
  output   = "../node_modules/@prisma/zod"
}
```

Then run:

```sh
npx prisma generate
```

## Requirements

- `prisma` + `@prisma/client`
- `zod`

## Development

```sh
npm run build
```
