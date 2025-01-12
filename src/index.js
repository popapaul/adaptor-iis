// @ts-nocheck
import { handler } from 'HANDLER';
import polka from 'polka';
import compression from 'compression';

const server = polka().use(compression()).use(handler);

server.listen(process.env.PORT ?? 3000);

export { server };
