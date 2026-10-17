// Vendored from qrcode-terminal 0.12.0, vendor/QRCode (Kazuhiko Arase).
// Local change: .cjs extension and explicit .cjs require paths for ESM hosts.
var QRMode = require('./QRMode.cjs');

function QR8bitByte(data) {
	this.mode = QRMode.MODE_8BIT_BYTE;
	this.data = data;
}

QR8bitByte.prototype = {

	getLength : function() {
		return this.data.length;
	},
	
	write : function(buffer) {
		for (var i = 0; i < this.data.length; i++) {
			// not JIS ...
			buffer.put(this.data.charCodeAt(i), 8);
		}
	}
};

module.exports = QR8bitByte;
