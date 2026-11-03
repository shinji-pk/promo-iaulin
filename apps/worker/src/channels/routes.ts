import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';
import { postStatuses } from '../../../../packages/shared/src/channels.ts';
import { ChannelError, type ChannelService } from './service.ts';

const id = (value: unknown) => z.string().min(1).max(100).parse(value);

/**
 * /api/v1/channels — all routes act on this installation's own channels. The installation is
 * the ownership boundary (each account pairs its own computer or server); every post, source
 * and news id is also checked against the channel in the URL.
 */
export function createChannelRouter(service: ChannelService, ownerOnly: RequestHandler): express.Router {
  const router = express.Router();
  const handle = (operation: (request: Request, response: Response) => unknown): RequestHandler => async (request, response, next: NextFunction) => {
    try { const result = await operation(request, response); if (!response.headersSent) response.json(result); }
    catch (error) {
      if (error instanceof ChannelError) { response.status(error.status).json({ error: error.message }); return; }
      if (error instanceof ZodError) { next(error); return; }
      if (error instanceof Error && !(error instanceof TypeError) && !(error instanceof RangeError)) { response.status(400).json({ error: error.message.slice(0, 500) }); return; }
      next(error);
    }
  };

  router.get('/', handle(() => service.overview()));
  router.post('/', handle(request => service.addChannel(request.body)));
  router.post('/pause', handle(request => service.setGlobalPause(request.body)));
  router.get('/events', handle(request => service.repo.listEvents({ ...(request.query.channelId ? { channelId: id(request.query.channelId) } : {}), limit: 300 })));
  router.get('/export', handle((_request, response) => { response.set('Content-Disposition', 'attachment; filename="promo-iaulin-canais.json"'); return service.export(); }));
  router.get('/ai', handle(() => service.ai.status()));
  router.put('/ai', handle(request => service.run(() => service.ai.saveSettings(request.body))));
  // The owner's own key: typed on the computer itself or sent by the site's own server.
  router.post('/ai/key', ownerOnly, handle(request => { const { key } = z.object({ key: z.string().min(16).max(400) }).strict().parse(request.body); return service.run(() => service.ai.saveKey(key)); }));
  router.delete('/ai/key', ownerOnly, handle(() => service.run(() => service.ai.removeKey())));
  router.get('/templates', handle(() => service.listTemplates()));
  router.post('/templates', handle(request => service.saveTemplate(request.body)));
  router.put('/templates/:templateId', handle(request => service.saveTemplate(request.body, id(request.params.templateId))));
  router.delete('/templates/:templateId', handle(request => service.deleteTemplate(id(request.params.templateId))));
  router.post('/media', handle(request => service.uploadMedia(request.body)));
  router.get('/media/:mediaId', (request, response) => {
    const file = service.media.read(z.uuid().parse(request.params.mediaId));
    if (!file) { response.status(404).json({ error: 'Arquivo não encontrado.' }); return; }
    response.set({ 'Content-Type': file.record.mime, 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(file.bytes);
  });

  router.get('/:channelId', handle(request => service.channelDetail(id(request.params.channelId))));
  router.put('/:channelId', handle(request => service.updateChannel(id(request.params.channelId), request.body)));
  router.delete('/:channelId', handle(request => service.unlinkChannel(id(request.params.channelId))));
  router.post('/:channelId/refresh', handle(request => service.refreshChannel(id(request.params.channelId))));
  router.post('/:channelId/pause', handle(request => service.pauseChannel(id(request.params.channelId), z.object({ paused: z.boolean() }).strict().parse(request.body).paused)));

  router.get('/:channelId/posts', handle(request => {
    const query = z.object({ status: z.enum(postStatuses).optional() }).strict().parse(request.query);
    const channelId = id(request.params.channelId);
    service.channelDetail(channelId);
    return service.repo.listPosts({ channelId, ...(query.status ? { statuses: [query.status] } : {}), limit: 500 });
  }));
  router.post('/:channelId/posts', handle(request => service.createPost(id(request.params.channelId), request.body)));
  router.get('/:channelId/posts/:postId', handle(request => service.postDetail(id(request.params.channelId), id(request.params.postId))));
  router.put('/:channelId/posts/:postId', handle(request => service.updatePost(id(request.params.channelId), id(request.params.postId), request.body)));
  router.delete('/:channelId/posts/:postId', handle(request => service.deletePost(id(request.params.channelId), id(request.params.postId))));
  router.post('/:channelId/posts/:postId/action', handle(request => service.action(id(request.params.channelId), id(request.params.postId), request.body)));
  router.post('/:channelId/posts/:postId/duplicate', handle(request => service.duplicatePost(id(request.params.channelId), id(request.params.postId), request.body)));

  router.get('/:channelId/sources', handle(request => { const channelId = id(request.params.channelId); service.channelDetail(channelId); return service.repo.listSources(channelId); }));
  router.post('/:channelId/sources', handle(request => service.addSource(id(request.params.channelId), request.body)));
  router.put('/:channelId/sources/:sourceId', handle(request => service.updateSource(id(request.params.channelId), id(request.params.sourceId), request.body)));
  router.delete('/:channelId/sources/:sourceId', handle(request => service.deleteSource(id(request.params.channelId), id(request.params.sourceId))));
  router.post('/:channelId/sources/:sourceId/test', handle(request => service.testSource(id(request.params.channelId), id(request.params.sourceId))));

  router.get('/:channelId/news', handle(request => {
    const channelId = id(request.params.channelId);
    service.channelDetail(channelId);
    const status = z.enum(['new', 'drafted', 'ignored', 'duplicate', 'excluded', 'irrelevant']).optional().parse(request.query.status);
    return service.repo.listNews(channelId, 300).filter(item => !status || item.status === status);
  }));
  router.post('/:channelId/news/run', handle(request => service.runNews(id(request.params.channelId))));
  router.post('/:channelId/news/:itemId/draft', handle(request => service.draftFromNews(id(request.params.channelId), id(request.params.itemId))));
  router.post('/:channelId/news/:itemId/ignore', handle(request => service.ignoreNews(id(request.params.channelId), id(request.params.itemId))));
  return router;
}
