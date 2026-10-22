"""Serve the local review prototype. No jobs or external requests are supported."""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class PrototypeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'")
        super().end_headers()

    def respond_json(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/catalog.js':
            catalog = (Path(self.directory) / 'product-catalog.json').read_text(encoding='utf-8')
            data = ('window.SignageCatalog = ' + catalog + ';\n').encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path.endswith('/api/config'):
            return self.respond_json(200, {'provider': 'prototype', 'configured': False, 'composite_configured': False, 'connection_message': 'Локальный прототип для проверки строк и логотипа.'})
        if '/api/' in path:
            return self.respond_json(200, {'jobs': [], 'items': []})
        if path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        if path == '/':
            self.path = '/calibrator.html'
        super().do_GET()

    def do_POST(self):
        self.respond_json(403, {'error': 'Локальный прототип: генерация и CorelDRAW доступны после внедрения.'})


if __name__ == '__main__':
    root = Path(__file__).resolve().parent / 'assets'
    print('Prototype: http://127.0.0.1:54760/calibrator.html', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 54760), partial(PrototypeHandler, directory=str(root))).serve_forever()
