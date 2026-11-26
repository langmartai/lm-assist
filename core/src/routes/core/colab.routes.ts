/**
 * Google Colab CLI Routes (lm-assist)
 *
 *   GET  /colab            -> { success: true, data: { actions, readActions, writeActions } }
 *   GET  /colab/status     -> runColabAction('doctor', {})
 *   POST /colab/:action    -> runColabAction(action, req.body || {})
 */

import type { RouteHandler, RouteContext } from '../index';
import {
  COLAB_ACTIONS,
  COLAB_READ_ACTIONS,
  COLAB_WRITE_ACTIONS,
  runColabAction,
} from '../../colab/colab-service';
import { completeColabLogin, startColabLogin } from '../../colab/colab-login';

export function createColabRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/colab$/,
      handler: async () => ({
        success: true,
        data: {
          actions: COLAB_ACTIONS,
          readActions: COLAB_READ_ACTIONS,
          writeActions: COLAB_WRITE_ACTIONS,
        },
      }),
    },
    {
      method: 'GET',
      pattern: /^\/colab\/status$/,
      handler: async () => {
        const r = await runColabAction('doctor', {});
        return { success: !!r.ok, ...r };
      },
    },
    {
      method: 'GET',
      pattern: /^\/colab\/login\/status$/,
      handler: async (req) => {
        const r = await runColabAction('doctor', req.query?.auth ? { auth: req.query.auth } : {});
        return { success: !!r.ok, ...r };
      },
    },
    {
      method: 'GET',
      pattern: /^\/colab\/overview$/,
      handler: async (req) => {
        const r = await runColabAction('overview', req.query?.auth ? { auth: req.query.auth } : {});
        return { success: !!r.ok, ...r };
      },
    },
    {
      method: 'GET',
      pattern: /^\/colab\/(usage|credits)$/,
      handler: async (req) => {
        const r = await runColabAction('usage', req.query?.auth ? { auth: req.query.auth } : {});
        return { success: !!r.ok, ...r };
      },
    },
    {
      method: 'GET',
      pattern: /^\/colab\/(sessions|instances)$/,
      handler: async (req) => {
        const r = await runColabAction('sessions', req.query?.auth ? { auth: req.query.auth } : {});
        return { success: !!r.ok, ...r };
      },
    },
    {
      method: 'POST',
      pattern: /^\/colab\/login\/start$/,
      handler: async (req) => {
        const r = await startColabLogin((req.body || {}) as Record<string, unknown>);
        return { success: !!r.ok, ...r };
      },
    },
    {
      method: 'POST',
      pattern: /^\/colab\/login\/complete$/,
      handler: async (req) => {
        const r = await completeColabLogin((req.body || {}) as Record<string, unknown>);
        return { success: !!r.ok, ...r };
      },
    },
    {
      method: 'POST',
      pattern: /^\/colab\/(?<action>.+)$/,
      handler: async (req) => {
        const action = decodeURIComponent(req.params.action || '');
        const r = await runColabAction(action, req.body || {});
        return { success: !!r.ok, ...r };
      },
    },
  ];
}
