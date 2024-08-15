import { Module } from "@nestjs/common";

import { NatsModule } from "../transports/nats.module";

import { OrdersService } from "./orders.service";

import { OrdersController } from "./orders.controller";

@Module({
  imports: [NatsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
