module.exports = (sequelize, DataTypes) => {
  const DeviceToken = sequelize.define(
    'DeviceToken',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      fcm_token: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      device_id: DataTypes.STRING,
      is_primary: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
    },
    {
      tableName: 'device_tokens',
      paranoid: true,
      underscored: true,
      indexes: [
        { unique: true, fields: ['emp_id', 'fcm_token'] },
      ],
    }
  );

  DeviceToken.associate = (models) => {
    DeviceToken.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    DeviceToken.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
  };

  return DeviceToken;
};
