import { ChatInputCommandInteraction } from 'discord.js';

import * as ping from './ping';
import * as horas from './horas';
import * as leaderboard from './leaderboard';
import * as replay from './replay';
import * as clip from './clip';
import * as play from './play';
import * as music from './music';
import * as call from './call';
import * as config from './config';
import * as privacidade from './privacidade';
import * as assinatura from './assinatura';
import * as feedback from './feedback';
import * as clear from './clear';
import * as help from './help';

// Lista única: o index e o deploy-commands liam listas separadas e a do deploy
// ficou quatro comandos atrás — rodar o script apagava /help, /clear,
// /assinatura e /feedback do Discord.
const modules = [
  ping, horas, leaderboard, replay, clip, play, music,
  call, config, privacidade, assinatura, feedback, clear, help,
];

export const commandHandlers = new Map<
  string,
  { execute: (i: ChatInputCommandInteraction) => Promise<void> }
>(modules.map((m) => [m.data.name, m]));

export const commandPayload = modules.map((m) => m.data.toJSON());
