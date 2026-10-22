"""Local preview using the release CSP, including blob model loading."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import importlib.util
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('deploy',root/'deploy/install-static.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
csp=deploy.BLOCK.split('Content-Security-Policy "')[1].split('"')[0]
class Handler(SimpleHTTPRequestHandler):
    extensions_map={**SimpleHTTPRequestHandler.extensions_map,'.mjs':'text/javascript'}
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(root/'dist'),**kwargs)
    def end_headers(self):
        self.send_header('Content-Security-Policy',csp)
        self.send_header('Cache-Control','no-store')
        super().end_headers()
    def log_message(self,*args):pass
ThreadingHTTPServer(('127.0.0.1',18894),Handler).serve_forever()
