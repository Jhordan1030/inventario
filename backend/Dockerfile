# Usar una imagen base de Node.js
FROM node:18-alpine

# Instalar dependencias de compilación necesarias para bcrypt
RUN apk add --no-cache python3 make g++

# Establecer el directorio de trabajo
WORKDIR /usr/src/app

# Copiar los archivos de configuración del proyecto
COPY package*.json ./

# Instalar las dependencias de Node.js
RUN npm install

# Copiar el resto de los archivos de la aplicación
COPY . .

# Eliminar las dependencias de compilación para reducir el tamaño de la imagen
RUN apk del python3 make g++

# Exponer el puerto donde la API estará escuchando
EXPOSE 5000

# Comando para iniciar la aplicación
CMD ["npm", "start"]
